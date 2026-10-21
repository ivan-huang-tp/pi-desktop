import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Terminal,
  Loader2,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
  Trash2,
  ArrowDown,
  Info,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { BashCommand, SessionLog } from '../types';
import { stripAnsi, formatDuration } from '../lib/ansi';

interface BashLogViewProps {
  commands: BashCommand[];
  sessionLogs?: SessionLog[];
  onClear?: () => void;
}

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('zh-TW', { hour12: false });

const StatusIcon: React.FC<{ status: BashCommand['status'] }> = ({ status }) => {
  if (status === 'running')
    return <Loader2 size={13} className="text-amber-400 animate-spin shrink-0" />;
  if (status === 'success')
    return <CheckCircle2 size={13} className="text-emerald-400/80 shrink-0" />;
  return <XCircle size={13} className="text-red-400 shrink-0" />;
};

const CopyButton: React.FC<{ title: string; active: boolean; onClick: () => void }> = ({
  title,
  active,
  onClick,
}) => (
  <button
    onClick={e => { e.stopPropagation(); onClick(); }}
    title={title}
    className="shrink-0 text-zinc-600 hover:text-zinc-100 transition"
  >
    {active ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
  </button>
);

// 展開狀態：0 = 單行、1 = 展開指令、2 = 顯示輸出
const CommandCard: React.FC<{ cmd: BashCommand }> = ({ cmd }) => {
  const [state, setState] = useState(0);
  const [copied, setCopied] = useState<'none' | 'cmd' | 'out'>('none');

  const text = useMemo(() => stripAnsi(cmd.output), [cmd.output]);
  const lineCount = useMemo(() => (text ? text.split('\n').length : 0), [text]);

  const running = cmd.status === 'running';
  const failed = cmd.status === 'failed';

  // 指令本身是否「需要展開」（多行或很長）
  const canExpandCommand = cmd.command.includes('\n') || cmd.command.length > 60;

  const cycle = () => {
    setState(s => (s === 0 ? (canExpandCommand ? 1 : 2) : s === 1 ? 2 : 0));
  };

  const copy = async (kind: 'cmd' | 'out') => {
    try {
      await navigator.clipboard.writeText(kind === 'cmd' ? cmd.command : text);
      setCopied(kind);
      setTimeout(() => setCopied('none'), 1200);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className={running ? 'bg-amber-500/[0.04]' : failed ? 'bg-red-500/[0.03]' : ''}>
      {/* 指令列 */}
      <div
        role="button"
        tabIndex={0}
        onClick={cycle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycle(); } }}
        className="flex items-start gap-2 px-2 py-2 cursor-pointer hover:bg-white/[0.03] outline-none"
        title={state === 0 ? '展開指令' : state === 1 ? '顯示輸出' : '收合'}
      >
        <span className="mt-[2px]"><StatusIcon status={cmd.status} /></span>

        <div className="flex-1 min-w-0">
          <code
            className={`block font-mono text-sm leading-[1.5] text-zinc-100 ${
              state === 0 ? 'truncate' : 'whitespace-pre-wrap break-all'
            }`}
          >
            <span className="text-emerald-400 select-none">$ </span>
            {cmd.command || '(empty)'}
          </code>

          {/* 展開後才顯示的中繼資訊 */}
          {state > 0 && (
            <div className="mt-1 flex items-center gap-2.5 text-xs text-zinc-600 font-mono">
              {running ? (
                <span className="text-amber-400">執行中…</span>
              ) : (
                cmd.durationMs != null && <span>{formatDuration(cmd.durationMs)}</span>
              )}
              {cmd.exitCode != null && cmd.exitCode !== 0 && (
                <span className="text-red-400">exit {cmd.exitCode}</span>
              )}
              {lineCount > 0 && <span>{lineCount} 行</span>}
              {cmd.truncated && <span className="text-amber-500">已截斷</span>}
              <span>{fmtTime(cmd.startedAt)}</span>
            </div>
          )}
        </div>

        {running && state === 0 && (
          <span className="mt-[1px] text-xs text-amber-400 shrink-0">執行中</span>
        )}
        <span className="mt-[1px]">
          <CopyButton title="複製指令" active={copied === 'cmd'} onClick={() => copy('cmd')} />
        </span>
      </div>

      {/* 輸出區（第二段展開才出現） */}
      {state === 2 && (
        <div className="relative pl-[30px] pr-2 pb-2.5">
          <div className="border-l border-[#2a2a30] pl-3 pt-0.5">
            {text ? (
              <pre className="max-h-[320px] overflow-auto text-xs leading-[1.55] font-mono text-zinc-300 whitespace-pre-wrap break-words">
                {text}
                {running && (
                  <span className="inline-block w-2 h-3.5 align-middle bg-emerald-400/80 animate-pulse ml-0.5" />
                )}
              </pre>
            ) : (
              <div className="text-xs text-zinc-600 italic">
                {running ? '等待輸出…' : '（此指令沒有產生任何輸出）'}
              </div>
            )}
            {cmd.fullOutputPath && (
              <div className="mt-1.5 text-xs text-zinc-600 font-mono truncate">
                完整輸出：{cmd.fullOutputPath}
              </div>
            )}
          </div>
          <span className="absolute top-0 right-2.5">
            <CopyButton title="複製輸出" active={copied === 'out'} onClick={() => copy('out')} />
          </span>
        </div>
      )}
    </div>
  );
};

export const BashLogView: React.FC<BashLogViewProps> = ({ commands, sessionLogs = [], onClear }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);

  const runningCount = commands.filter(c => c.status === 'running').length;
  const failedCount = commands.filter(c => c.status === 'failed').length;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [commands, sessionLogs]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickRef.current = nearBottom;
    if (nearBottom) setShowJump(false);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setShowJump(false);
  };

  return (
    <div className="relative h-full flex flex-col bg-[#101012]">
      {/* 工具列 */}
      <div className="h-10 px-2 border-b border-[#27272a] flex items-center justify-between text-xs text-zinc-400 shrink-0">
        <div className="flex items-center gap-2">
          <Terminal size={13} className="text-emerald-400" />
          <span className="text-zinc-300">Pi 指令紀錄</span>
          <span className="text-zinc-700">·</span>
          <span>{commands.length} 個指令</span>
          {runningCount > 0 && (
            <span className="flex items-center gap-1 text-amber-300">
              <Loader2 size={11} className="animate-spin" /> {runningCount}
            </span>
          )}
          {failedCount > 0 && <span className="text-red-300">{failedCount} 失敗</span>}
        </div>
        {onClear && commands.length > 0 && (
          <button
            onClick={onClear}
            className="flex items-center gap-1 hover:text-zinc-200 transition"
            title="清空紀錄"
          >
            <Trash2 size={12} /> 清空
          </button>
        )}
      </div>

      {/* 內容 */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
        {/* 連線／核心訊息（預設收合） */}
        {sessionLogs.length > 0 && (
          <div className="rounded-md border border-[#232327] bg-[#141416] overflow-hidden">
            <button
              onClick={() => setLogsOpen(o => !o)}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs text-zinc-600 hover:text-zinc-300"
            >
              {logsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Info size={12} />
              連線與核心訊息（{sessionLogs.length}）
            </button>
            {logsOpen && (
              <div className="border-t border-[#232327] px-2 py-1.5 space-y-0.5">
                {sessionLogs.map(l => (
                  <div key={l.id} className="text-xs font-mono text-zinc-600 whitespace-pre-wrap break-words">
                    <span className="text-zinc-700 mr-1.5">{fmtTime(l.ts)}</span>
                    {stripAnsi(l.text)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {commands.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center text-zinc-700 gap-2 py-16">
            <Terminal size={26} className="opacity-40" />
            <div className="text-sm">尚無指令紀錄</div>
            <div className="text-xs text-zinc-800">當 Pi 執行 bash 指令時，會即時顯示在這裡</div>
          </div>
        )}

        {commands.length > 0 && (
          <div className="rounded-md border border-[#232327] bg-[#141416] overflow-hidden divide-y divide-[#1c1c20]">
            {commands.map(cmd => (
              <CommandCard key={cmd.id} cmd={cmd} />
            ))}
          </div>
        )}
      </div>

      {/* 回到最新 */}
      {showJump && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-4 right-4 flex items-center gap-1 rounded-full bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-xs text-white shadow-lg"
        >
          <ArrowDown size={12} /> 最新
        </button>
      )}
    </div>
  );
};
