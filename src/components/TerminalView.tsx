import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Trash2, Copy, Terminal as TerminalIcon } from 'lucide-react';

interface TerminalViewProps {
  logs: string[];
  activeCommand?: string;
  onClear?: () => void;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  logs,
  activeCommand,
  onClear,
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermInstance = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new XTerm({
      theme: {
        background: '#121214',
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
      },
      fontFamily: 'Consolas, Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      convertEol: true,
      disableStdin: true, // 檢視模式，主要看 AI 跑指令
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    xtermInstance.current = term;
    fitAddonRef.current = fitAddon;

    term.writeln('\x1b[1;34m[Pi Terminal Watcher]\x1b[0m 監聽 Pi Agent Bash Tool 執行串流...');
    term.writeln('\x1b[90m--------------------------------------------------\x1b[0m');

    const handleResize = () => {
      try {
        fitAddon.fit();
      } catch (e) {
        // ignore resize error on unmounted
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
    };
  }, []);

  // 當 logs 更新時，寫入終端機
  const lastLogIndex = useRef(0);
  useEffect(() => {
    const term = xtermInstance.current;
    if (!term) return;

    if (logs.length < lastLogIndex.current) {
      // 被清空了
      term.clear();
      lastLogIndex.current = 0;
    }

    for (let i = lastLogIndex.current; i < logs.length; i++) {
      term.writeln(logs[i]);
    }
    lastLogIndex.current = logs.length;
  }, [logs]);

  // 當有新指令開始執行時，印出漂亮的指令提示
  useEffect(() => {
    const term = xtermInstance.current;
    if (!term || !activeCommand) return;
    term.writeln(`\r\n\x1b[1;32m$ ${activeCommand}\x1b[0m`);
  }, [activeCommand]);

  const handleClear = () => {
    xtermInstance.current?.clear();
    onClear?.();
  };

  const handleCopy = () => {
    const text = logs.join('\n');
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="h-full flex flex-col bg-[#121214] overflow-hidden select-text">
      {/* 終端機頂部工具列 */}
      <div className="h-10 px-2 bg-[#18181b] border-b border-[#27272a] flex items-center justify-between text-sm text-zinc-400 select-none">
        <div className="flex items-center space-x-2">
          <TerminalIcon size={14} className="text-emerald-400" />
          <span className="font-mono text-zinc-300 font-medium">Bash Execution Stream</span>
          {activeCommand && (
            <span className="px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-400 border border-emerald-800/50 text-xs animate-pulse">
              Running
            </span>
          )}
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={handleCopy}
            title="複製全部日誌"
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition"
          >
            <Copy size={13} />
          </button>
          <button
            onClick={handleClear}
            title="清空終端機"
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* xterm 渲染容器 */}
      <div className="flex-1 p-2 bg-[#121214] overflow-hidden" ref={terminalRef} />
    </div>
  );
};
