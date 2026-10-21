import React, { useState, useEffect, useCallback } from 'react';
import {
  Settings,
  X,
  FolderOpen,
  Activity,
  AlertCircle,
  CheckCircle2,
  Terminal,
  Flag,
  Save,
  FileText,
  RefreshCw,
} from 'lucide-react';
import { ipcRenderer } from '../lib/ipc';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface TraceSettings {
  enabled: boolean;
  dir: string;
}

interface RemoteTerminalSettings {
  useTmux: boolean;
}

interface TraceStats {
  enabled: boolean;
  dir: string;
  file: string;
  bytesWritten: number;
  queued: number;
  lastError: string | null;
  errorCount: number;
}

const formatBytes = (n?: number) => {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const [trace, setTrace] = useState<TraceSettings>({ enabled: false, dir: 'R:\\Temp' });
  const [remoteTerminal, setRemoteTerminal] = useState<RemoteTerminalSettings>({ useTmux: true });
  const [configFile, setConfigFile] = useState<string>('');
  const [stats, setStats] = useState<TraceStats | null>(null);
  const [dirty, setDirty] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'ok' | 'error' | 'info' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [markText, setMarkText] = useState('');

  const loadSettings = useCallback(async () => {
    if (!ipcRenderer) return;
    const res = await ipcRenderer.invoke('settings:get');
    if (res?.success) {
      setTrace(res.settings.trace || { enabled: false, dir: 'R:\\Temp' });
      setRemoteTerminal(res.settings.remoteTerminal || { useTmux: true });
      setConfigFile(res.file || '');
      setStats(res.stats || null);
      setDirty(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    loadSettings();
    setStatusMessage(null);
  }, [isOpen, loadSettings]);

  // trace 寫入失敗時主程序會送這個事件（例如 R: 不存在或被拔掉）
  useEffect(() => {
    if (!ipcRenderer || !isOpen) return;
    const handler = (_e: any, payload: { message: string; file: string }) => {
      setStatusMessage({
        text: `Trace 寫入失敗：${payload?.message}（目標：${payload?.file}）——已自動停寫，不影響程式運作`,
        type: 'error',
      });
      loadSettings();
    };
    ipcRenderer.on('trace:error', handler);
    return () => ipcRenderer?.removeListener('trace:error', handler);
  }, [isOpen, loadSettings]);

  // 開啟時定期更新統計（只在啟用狀態下才需要）
  useEffect(() => {
    if (!isOpen || !trace.enabled) return;
    const timer = setInterval(async () => {
      const s = await ipcRenderer?.invoke('trace:get-stats');
      if (s) setStats(s);
    }, 3000);
    return () => clearInterval(timer);
  }, [isOpen, trace.enabled]);

  if (!isOpen) return null;

  const handleSave = async () => {
    if (!ipcRenderer) return;
    setBusy(true);
    const res = await ipcRenderer.invoke('settings:set', { trace, remoteTerminal });
    setBusy(false);
    if (res?.success) {
      setStats((prev) => (prev ? { ...prev, enabled: trace.enabled, dir: trace.dir } : prev));
      setDirty(false);
      setStatusMessage({
        text: trace.enabled
          ? `已儲存，Trace 已啟用 → ${trace.dir}`
          : '已儲存，Trace 已關閉（完全不寫檔，速度不受影響）',
        type: 'ok',
      });
    } else {
      setStatusMessage({ text: `儲存失敗：${res?.error || '未知錯誤'}`, type: 'error' });
    }
  };

  const handleChooseDir = async () => {
    if (!ipcRenderer) return;
    const res = await ipcRenderer.invoke('trace:choose-dir');
    if (res?.success) {
      setTrace((prev) => ({ ...prev, dir: res.dir }));
      setDirty(true);
    }
  };

  const handleTestWrite = async () => {
    if (!ipcRenderer) return;
    setBusy(true);
    // 先存檔再測，確保測到的是使用者現在填的目錄
    await ipcRenderer.invoke('settings:set', { trace, remoteTerminal });
    const res = await ipcRenderer.invoke('trace:test-write');
    setBusy(false);
    if (res?.success) {
      setStats(res.stats || null);
      setDirty(false);
      setStatusMessage({ text: `測試成功，可以寫入：${res.file}`, type: 'ok' });
    } else {
      setStatusMessage({
        text: `測試失敗，無法寫入「${res?.dir || trace.dir}」：${res?.error || '未知錯誤'}。請改選一個存在的目錄。`,
        type: 'error',
      });
    }
  };

  const handleMark = async () => {
    if (!ipcRenderer) return;
    const res = await ipcRenderer.invoke('trace:mark', { text: markText });
    if (res?.success) {
      setStats(res.stats || null);
      setMarkText('');
      setStatusMessage({ text: '已寫入標記，接著重現問題即可', type: 'ok' });
    } else {
      setStatusMessage({ text: `標記失敗：${res?.error || '未知錯誤'}`, type: 'error' });
    }
  };

  const handleOpen = async (mode: 'file' | 'folder') => {
    const res = await ipcRenderer?.invoke('trace:open', { mode });
    if (res && !res.success) {
      setStatusMessage({ text: `無法開啟：${res.error}`, type: 'error' });
    }
  };

  // 註：track/knob 用 arbitrary value（[22px]/[18px]），因為 Tailwind 3.4 預設 spacing scale
  // 沒有 4.5 / 5.5 這兩個值，寫 w-4.5 會完全長不出樣式。
  const toggleStyle = (on: boolean) =>
    `relative w-10 h-[22px] rounded-full transition shrink-0 ${on ? 'bg-indigo-600' : 'bg-zinc-700'}`;

  const knobStyle = (on: boolean) =>
    `absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white transition-all ${on ? 'left-[20px]' : 'left-[2px]'}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#18181b] border border-zinc-800 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[88vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-zinc-800/80 bg-zinc-900/50 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <Settings className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">程式設定</h2>
              <p className="text-sm text-zinc-400">Trace 記錄與遠端終端機行為</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4 text-sm text-zinc-300 overflow-y-auto">
          {/* ---- Trace ---- */}
          <div className="rounded-lg bg-zinc-900/60 border border-zinc-800/80 overflow-hidden">
            <div className="flex items-center justify-between px-3.5 py-3 border-b border-zinc-800/60">
              <div className="flex items-center gap-2">
                <Activity className={`w-4 h-4 ${trace.enabled ? 'text-emerald-400' : 'text-zinc-500'}`} />
                <div>
                  <div className="text-zinc-100 font-medium">啟用 Trace 記錄</div>
                  <div className="text-xs text-zinc-500">
                    {trace.enabled
                      ? '會持續寫入記錄檔，遇到問題時可直接把檔案給我分析'
                      : '已關閉：完全不建立檔案、不寫硬碟，速度不受影響'}
                  </div>
                </div>
              </div>
              <button
                onClick={() => {
                  setTrace((p) => ({ ...p, enabled: !p.enabled }));
                  setDirty(true);
                }}
                className={toggleStyle(trace.enabled)}
                title={trace.enabled ? '點擊關閉' : '點擊啟用'}
              >
                <span className={knobStyle(trace.enabled)} />
              </button>
            </div>

            <div className="px-3.5 py-3 space-y-3">
              {/* 目錄 */}
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5 font-medium">記錄目錄</label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={trace.dir}
                    onChange={(e) => {
                      setTrace((p) => ({ ...p, dir: e.target.value }));
                      setDirty(true);
                    }}
                    placeholder="R:\Temp"
                    className="flex-1 bg-zinc-900 border border-zinc-700/80 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    onClick={handleChooseDir}
                    title="選擇目錄"
                    className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={handleTestWrite}
                    disabled={busy}
                    className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-xs transition whitespace-nowrap"
                  >
                    測試寫入
                  </button>
                </div>
                <div className="mt-1.5 text-xs text-zinc-500 font-mono break-all">
                  {stats?.file || `${trace.dir}\\pi-agent-desktop-trace.log`}
                </div>
              </div>

              {/* 狀態 */}
              {stats && (
                <div className="flex items-center gap-3 text-xs text-zinc-500 flex-wrap">
                  <span className="inline-flex items-center gap-1">
                    <FileText className="w-3 h-3" />
                    目前大小 {formatBytes(stats.bytesWritten)}
                  </span>
                  <span>·</span>
                  <span>待寫入佇列 {stats.queued}</span>
                  {stats.errorCount > 0 && (
                    <>
                      <span>·</span>
                      <span className="text-rose-400 inline-flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        寫入失敗 {stats.errorCount} 次
                      </span>
                    </>
                  )}
                </div>
              )}

              {/* 操作 */}
              <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                <input
                  type="text"
                  value={markText}
                  onChange={(e) => setMarkText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleMark()}
                  placeholder="標記說明（例如：按下執行 base）"
                  className="flex-1 min-w-[8rem] bg-zinc-900 border border-zinc-700/80 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                />
                <button
                  onClick={handleMark}
                  disabled={!trace.enabled}
                  title={trace.enabled ? '在 trace 中寫入一個時間標記' : '請先啟用 Trace'}
                  className="px-2.5 py-1.5 rounded-lg bg-amber-600/80 hover:bg-amber-500 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-white text-xs font-medium transition inline-flex items-center gap-1"
                >
                  <Flag className="w-3 h-3" />
                  標記
                </button>
                <button
                  onClick={() => handleOpen('folder')}
                  className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs transition"
                >
                  開資料夾
                </button>
                <button
                  onClick={() => handleOpen('file')}
                  className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs transition"
                >
                  開檔案
                </button>
              </div>

              <div className="text-xs text-zinc-500 leading-relaxed bg-zinc-900/40 p-2.5 rounded border border-zinc-800/40">
                <span className="text-zinc-400 font-semibold">怎麼用：</span>
                遇到問題前先按「標記」寫一句說明，重現問題後回報，我就能在 trace 裡直接定位那段時間的
                SSH 進出、pi 指令與事件、終端機 I/O。<b className="text-zinc-400">密碼、API Key、私鑰都會自動遮蔽</b>，可以放心傳。
                單檔超過 8MB 會自動輪替，保留最近 5 份。
              </div>
            </div>
          </div>

          {/* ---- 遠端終端機 ---- */}
          <div className="rounded-lg bg-zinc-900/60 border border-zinc-800/80 overflow-hidden">
            <div className="flex items-center justify-between px-3.5 py-3">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-zinc-400" />
                <div>
                  <div className="text-zinc-100 font-medium">遠端終端機使用 tmux</div>
                  <div className="text-xs text-zinc-500">
                    {remoteTerminal.useTmux
                      ? '斷線、關面板、重開程式都不會殺掉遠端正在跑的工作'
                      : '斷線時遠端正在跑的工作會一起被殺掉（ssh 的 pty 被關閉）'}
                  </div>
                </div>
              </div>
              <button
                onClick={() => {
                  setRemoteTerminal((p) => ({ ...p, useTmux: !p.useTmux }));
                  setDirty(true);
                }}
                className={toggleStyle(remoteTerminal.useTmux)}
              >
                <span className={knobStyle(remoteTerminal.useTmux)} />
              </button>
            </div>
            <div className="px-3.5 pb-3 text-xs text-zinc-500 leading-relaxed">
              每個遠端目錄會建立一個固定的 tmux session（名稱 <code className="text-zinc-400">piui-&lt;資料夾名&gt;</code>），
              再次開啟同一目錄時會自動接回原來的畫面。<b className="text-zinc-400">遠端必須已安裝 tmux</b>；
              沒有的話會自動退回原本的普通 shell，不會壞掉。變更後新開的終端機才生效。
            </div>
          </div>

          {/* 狀態訊息 */}
          {statusMessage && (
            <div
              className={`flex items-start gap-2 p-2.5 rounded-lg border ${
                statusMessage.type === 'ok'
                  ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                  : statusMessage.type === 'error'
                    ? 'bg-rose-500/10 border-rose-500/20 text-rose-300'
                    : 'bg-blue-500/10 border-blue-500/20 text-blue-300'
              }`}
            >
              {statusMessage.type === 'error' ? (
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span className="break-all">{statusMessage.text}</span>
            </div>
          )}

          {configFile && (
            <div className="text-xs text-zinc-600 font-mono truncate" title={configFile}>
              設定檔：{configFile}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-zinc-800/80 bg-zinc-900/40 shrink-0">
          <button
            onClick={loadSettings}
            className="px-3 py-2 rounded-lg text-zinc-400 hover:text-zinc-200 text-xs transition inline-flex items-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            重新載入
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-2 rounded-lg text-zinc-400 hover:text-zinc-200 text-xs transition"
            >
              關閉
            </button>
            <button
              onClick={handleSave}
              disabled={busy || !dirty}
              className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-white text-xs font-medium transition inline-flex items-center gap-1.5"
            >
              <Save className="w-3.5 h-3.5" />
              {dirty ? '儲存設定' : '已儲存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
