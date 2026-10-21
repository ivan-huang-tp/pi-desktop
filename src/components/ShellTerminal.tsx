import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Plus, X, ChevronDown, Trash2, Terminal as TerminalIcon } from 'lucide-react';

// 取得 Electron IPC（在 Electron 環境中可用）
const electron = (window as any).require ? (window as any).require('electron') : null;
const ipcRenderer = electron?.ipcRenderer;

interface ShellInfo {
  id: string;
  name: string;
}

interface TabInfo {
  key: number;
  shellId?: string;
  title: string;
}

/* ------------------------------------------------------------------ */
/* 全域資料分派器：所有終端機共用一組 IPC 監聽，依 id 分送輸出            */
/* ------------------------------------------------------------------ */
type DataHandler = (data: string) => void;
type ExitHandler = (code: number) => void;
const dataHandlers = new Map<string, DataHandler>();
const exitHandlers = new Map<string, ExitHandler>();
const pendingData = new Map<string, string>();
let dispatcherReady = false;

const ensureDispatcher = () => {
  if (dispatcherReady || !ipcRenderer) return;
  dispatcherReady = true;
  ipcRenderer.on('term:data', (_e: any, { id, data }: { id: string; data: string }) => {
    const h = dataHandlers.get(id);
    if (h) h(data);
    else pendingData.set(id, (pendingData.get(id) || '') + data);
  });
  ipcRenderer.on('term:exit', (_e: any, { id, exitCode }: { id: string; exitCode: number }) => {
    exitHandlers.get(id)?.(exitCode);
  });
};

const XTERM_THEME = {
  background: '#101012',
  foreground: '#e4e4e7',
  cursor: '#a1a1aa',
  selectionBackground: '#3f3f46',
  black: '#18181b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#38bdf8',
  white: '#f4f4f5',
  brightBlack: '#71717a',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#ffffff',
};

/* ------------------------------------------------------------------ */
/* 單一終端機實例：掛載時建立 xterm 與 pty，卸載時關閉                    */
/* ------------------------------------------------------------------ */
interface TerminalInstanceProps {
  shellId?: string;
  cwd: string;
  visible: boolean;
  clearSignal: number;
  onReady: (shellName: string) => void;
  onExit: () => void;
}

const TerminalInstance: React.FC<TerminalInstanceProps> = ({
  shellId,
  cwd,
  visible,
  clearSignal,
  onReady,
  onExit,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const callbacksRef = useRef({ onReady, onExit });
  callbacksRef.current = { onReady, onExit };

  // 依容器大小調整欄列數，並同步給 pty
  const fit = useCallback(() => {
    const el = containerRef.current;
    const fitAddon = fitRef.current;
    const term = termRef.current;
    if (!el || !fitAddon || !term || el.offsetWidth === 0 || el.offsetHeight === 0) return;
    try {
      fitAddon.fit();
    } catch {
      return;
    }
    if (ptyIdRef.current) {
      ipcRenderer?.send('term:resize', { id: ptyIdRef.current, cols: term.cols, rows: term.rows });
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    ensureDispatcher();
    let disposed = false;

    const term = new XTerm({
      theme: XTERM_THEME,
      fontFamily: 'Consolas, "Cascadia Mono", Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fitAddon;
    try {
      fitAddon.fit();
    } catch {
      /* 容器尚未可見 */
    }

    // Ctrl+C（有選取時）複製、Ctrl+Shift+C / Ctrl+Shift+V 複製貼上，與 VS Code 一致
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const key = e.key.toLowerCase();
      if (e.ctrlKey && key === 'c' && (e.shiftKey || term.hasSelection())) {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        term.clearSelection();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && key === 'v') {
        navigator.clipboard.readText().then((t) => t && term.paste(t)).catch(() => {});
        return false;
      }
      return true;
    });

    // 使用者輸入 → pty
    const inputSub = term.onData((data) => {
      if (ptyIdRef.current) ipcRenderer?.send('term:write', { id: ptyIdRef.current, data });
    });

    if (!ipcRenderer) {
      term.writeln('\x1b[33m此功能需要在 Electron 桌面版中執行。\x1b[0m');
    } else {
      ipcRenderer
        .invoke('term:create', { shellId, cwd, cols: term.cols, rows: term.rows })
        .then((res: any) => {
          if (!res?.success) {
            term.writeln(`\x1b[31m無法啟動終端機：${res?.error || '未知錯誤'}\x1b[0m`);
            return;
          }
          // StrictMode 或快速關閉：建立完成時元件已卸載 → 直接關掉
          if (disposed) {
            ipcRenderer.send('term:kill', { id: res.id });
            return;
          }
          ptyIdRef.current = res.id;
          dataHandlers.set(res.id, (data) => term.write(data));
          exitHandlers.set(res.id, () => callbacksRef.current.onExit());
          const buffered = pendingData.get(res.id);
          if (buffered) {
            term.write(buffered);
            pendingData.delete(res.id);
          }
          callbacksRef.current.onReady(res.shellName);
          fit();
        });
    }

    // 容器大小改變（拖曳面板、視窗縮放）時自動調整
    const ro = new ResizeObserver(() => fit());
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      ro.disconnect();
      inputSub.dispose();
      const id = ptyIdRef.current;
      if (id) {
        dataHandlers.delete(id);
        exitHandlers.delete(id);
        pendingData.delete(id);
        ipcRenderer?.send('term:kill', { id });
      }
      ptyIdRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // 只在掛載時建立一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切換為可見時重新調整大小並聚焦
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      fit();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, fit]);

  // 清除畫面（只清目前顯示中的分頁；記錄已處理的訊號避免切換分頁時誤清）
  const handledClearRef = useRef(clearSignal);
  useEffect(() => {
    if (clearSignal === handledClearRef.current) return;
    handledClearRef.current = clearSignal;
    if (visible) termRef.current?.clear();
  }, [clearSignal, visible]);

  return (
    <div
      className="absolute inset-0 pl-2 pt-1.5"
      style={{ display: visible ? 'block' : 'none' }}
    >
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* 終端機面板：多分頁 + 選擇 shell                                       */
/* ------------------------------------------------------------------ */
interface ShellTerminalProps {
  cwd: string;
}

export const ShellTerminal: React.FC<ShellTerminalProps> = ({ cwd }) => {
  const nextKey = useRef(2);
  const [tabs, setTabs] = useState<TabInfo[]>([{ key: 1, title: '終端機' }]);
  const [activeKey, setActiveKey] = useState(1);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [clearSignal, setClearSignal] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const tabStripRef = useRef<HTMLDivElement>(null);

  // 切換／新增分頁時，自動捲到看得見該分頁
  useEffect(() => {
    const el = tabStripRef.current?.querySelector<HTMLElement>(`[data-tab-key="${activeKey}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeKey, tabs.length]);

  useEffect(() => {
    ipcRenderer
      ?.invoke('term:list-shells')
      .then((res: any) => setShells(res?.shells || []))
      .catch(() => {});
  }, []);

  // 點擊外部關閉 shell 選單
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const addTab = (shellId?: string) => {
    const key = nextKey.current++;
    const shellName = shells.find((s) => s.id === shellId)?.name;
    setTabs((prev) => [...prev, { key, shellId, title: shellName || '終端機' }]);
    setActiveKey(key);
    setMenuOpen(false);
  };

  const closeTab = (key: number) => {
    const idx = tabs.findIndex((t) => t.key === key);
    if (idx === -1) return;
    const next = tabs.filter((t) => t.key !== key);
    setTabs(next);
    if (activeKey === key) {
      const neighbor = next[idx] || next[idx - 1];
      setActiveKey(neighbor ? neighbor.key : -1);
    }
  };

  const setTitle = useCallback((key: number, title: string) => {
    setTabs((prev) => prev.map((t) => (t.key === key ? { ...t, title } : t)));
  }, []);

  return (
    <div className="relative h-full flex flex-col bg-[#101012]">
      {/* 工具列：分頁 + 新增 + 清除 */}
      <div className="h-10 px-1.5 border-b border-[#27272a] flex items-center gap-1 text-xs text-zinc-400 shrink-0">
        {/* 分頁像瀏覽器一樣平均分配寬度：分頁越多每個越窄，縮到最小寬度後改為左右捲動 */}
        <div
          ref={tabStripRef}
          onWheel={(e) => {
            // 滑鼠滾輪直接左右捲動分頁列
            const el = tabStripRef.current;
            if (el && e.deltaY !== 0 && el.scrollWidth > el.clientWidth) el.scrollLeft += e.deltaY;
          }}
          className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto"
        >
          {tabs.map((t) => (
            <div
              key={t.key}
              data-tab-key={t.key}
              onClick={() => setActiveKey(t.key)}
              title={t.title}
              className={`group flex-1 basis-0 min-w-[96px] max-w-[160px] flex items-center gap-1.5 pl-2 pr-1 py-1 rounded cursor-pointer overflow-hidden transition ${
                t.key === activeKey
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'hover:bg-zinc-800/40 hover:text-zinc-300'
              }`}
            >
              <TerminalIcon size={12} className="text-emerald-400 shrink-0" />
              <span className="flex-1 min-w-0 truncate">{t.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.key);
                }}
                title="關閉終端機"
                className={`shrink-0 p-0.5 rounded hover:bg-zinc-700 hover:text-zinc-100 ${
                  t.key === activeKey ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>

        {/* 新增終端機（左：預設 shell，右：選擇 shell） */}
        <div ref={menuRef} className="relative flex items-center shrink-0">
          <button
            onClick={() => addTab()}
            title="新增終端機"
            className="p-1 rounded-l hover:bg-zinc-800 hover:text-zinc-100 transition"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            title="選擇 Shell"
            className="py-1 px-0.5 rounded-r hover:bg-zinc-800 hover:text-zinc-100 transition"
          >
            <ChevronDown size={12} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 z-20 min-w-[170px] rounded-md border border-[#2f2f35] bg-[#1c1c20] py-1 shadow-xl">
              {shells.length === 0 && (
                <div className="px-3 py-1.5 text-zinc-500">找不到可用的 Shell</div>
              )}
              {shells.map((s) => (
                <button
                  key={s.id}
                  onClick={() => addTab(s.id)}
                  className="w-full text-left px-3 py-1.5 text-zinc-300 hover:bg-zinc-700/60 hover:text-zinc-100"
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={() => setClearSignal((n) => n + 1)}
          title="清除畫面"
          className="p-1 rounded hover:bg-zinc-800 hover:text-zinc-100 transition shrink-0"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* 終端機內容（所有分頁都保持掛載，只切換顯示） */}
      <div className="relative flex-1 min-h-0">
        {tabs.map((t) => (
          <TerminalInstance
            key={t.key}
            shellId={t.shellId}
            cwd={cwd}
            visible={t.key === activeKey}
            clearSignal={clearSignal}
            onReady={(name) => setTitle(t.key, name)}
            onExit={() => closeTab(t.key)}
          />
        ))}

        {tabs.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-zinc-600">
            <TerminalIcon size={26} className="opacity-40" />
            <div className="text-sm">沒有開啟的終端機</div>
            <button
              onClick={() => addTab()}
              className="flex items-center gap-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 text-xs text-zinc-200 transition"
            >
              <Plus size={12} /> 新增終端機
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
