import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send,
  Terminal,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Sparkles,
  Bot,
  User,
  Square,
  ArrowDown,
  MessageSquare,
  Cpu,
  Brain,
  Sliders,
  Copy,
  Check,
  Pencil,
  RotateCcw,
  GitBranch,
  Bookmark,
  EyeOff,
  Eye,
  X,
  Trash2,
} from 'lucide-react';
import type { Message, SubagentTask, ToolCall } from '../types';
import { SubagentCard } from './SubagentCard';
import { Markdown } from './Markdown';
import { DiffToolCard, isFileEditTool } from './DiffToolCard';
import { getMessageParts } from '../lib/messageParts';

interface ChatAreaProps {
  messages: Message[];
  isLoading: boolean;
  onSendMessage: (text: string) => void;
  onStop: () => void;
  onInspectSubagent?: (task: SubagentTask) => void;
  projectName?: string;
  projectPath?: string;
  conversationId?: string;
  modelInfo?: string;
  thinkingLevel?: string;
  onOpenModelSettings?: () => void;
  /** 單一使用者訊息粒度操作回呼 */
  onCopyMessage?: (text: string) => void;
  onSwitchBranch?: (message: Message, targetLeafId: string) => void;
  onEditAndResend?: (message: Message, newText: string, userTurnIndex: number) => void;
  onRegenerate?: (message: Message, userTurnIndex: number) => void;
  onForkFromMessage?: (message: Message, userTurnIndex: number) => void;
  onSetMessageLabel?: (message: Message, label: string | undefined, userTurnIndex: number) => void;
  onToggleMessageOmit?: (message: Message, userTurnIndex: number) => void;
  onOpenPath?: (path: string) => void;
}

/* ------------------------------------------------------------------ */
/* 純圖示 + 即時懸浮 Tooltip 按鈕元件（無文字、無表情符號）                */
/* ------------------------------------------------------------------ */
interface IconTipButtonProps {
  icon: React.ReactNode;
  tooltip: string;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  active?: boolean;
  activeClassName?: string;
  danger?: boolean;
  className?: string;
}

const IconTipButton: React.FC<IconTipButtonProps> = ({
  icon,
  tooltip,
  onClick,
  disabled = false,
  active = false,
  activeClassName = 'text-indigo-400 bg-indigo-500/15 border-indigo-500/30',
  danger = false,
  className = '',
}) => {
  return (
    <div className="relative group/tip inline-flex">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={tooltip}
        className={`p-1.5 rounded-md border transition flex items-center justify-center disabled:opacity-35 disabled:pointer-events-none ${
          danger
            ? 'border-transparent text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 hover:border-rose-500/20'
            : active
              ? activeClassName
              : 'border-transparent text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/90 hover:border-zinc-700/60'
        } ${className}`}
      >
        {icon}
      </button>
      <div className="pointer-events-none absolute bottom-full right-0 mb-1.5 opacity-0 group-hover/tip:opacity-100 transition-opacity duration-150 z-40">
        <div className="px-2 py-1 rounded-md bg-zinc-950/95 border border-zinc-700/80 text-[11px] font-sans text-zinc-200 whitespace-nowrap shadow-xl">
          {tooltip}
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* 單一訊息列：以 React.memo 包裝，只有該訊息或展開狀態改變時才重繪      */
/* ------------------------------------------------------------------ */
interface MessageItemProps {
  message: Message;
  userTurnIndex: number;
  isLoading: boolean;
  onInspectSubagent?: (task: SubagentTask) => void;
  onCopyMessage?: (text: string) => void;
  onSwitchBranch?: (message: Message, targetLeafId: string) => void;
  onEditAndResend?: (message: Message, newText: string, userTurnIndex: number) => void;
  onRegenerate?: (message: Message, userTurnIndex: number) => void;
  onForkFromMessage?: (message: Message, userTurnIndex: number) => void;
  onSetMessageLabel?: (message: Message, label: string | undefined, userTurnIndex: number) => void;
  onToggleMessageOmit?: (message: Message, userTurnIndex: number) => void;
  onOpenPath?: (path: string) => void;
}

/* ------------------------------------------------------------------ */
/* 工具呼叫卡片：獨立元件，供有序片段渲染使用                            */
/* ------------------------------------------------------------------ */
// 工具參數摘要（收合時單行顯示）
const toolSummary = (tool: ToolCall): string => {
  const a = tool.args || {};
  let summary = '';
  if (typeof a.command === 'string') summary = a.command;
  else if (typeof a.path === 'string') summary = a.path;
  else if (typeof a.file_path === 'string') summary = a.file_path;
  else {
    try {
      summary = JSON.stringify(a);
    } catch {
      summary = String(a);
    }
  }
  // 將換行替換為單一空格並去除頭尾空白，確保收合單行預覽時整潔不跳行
  return summary.replace(/\r?\n/g, ' ').trim();
};

// 工具參數完整內容（第一段展開時顯示）
const toolDetail = (tool: ToolCall): string => {
  const a = tool.args || {};
  if (typeof a.command === 'string') return a.command;
  try {
    return JSON.stringify(a, null, 2);
  } catch {
    return String(a);
  }
};

// 展開狀態（與右欄指令卡片一致）：0 = 單行、1 = 展開指令、2 = 顯示輸出
const ToolCallCard: React.FC<{ tool: ToolCall; onOpenPath?: (path: string) => void }> = ({
  tool,
  onOpenPath,
}) => {
  const [state, setState] = useState(0);
  const cycle = () => setState((s) => (s + 1) % 3);

  const summary = toolSummary(tool);
  const detail = toolDetail(tool);
  const output = tool.output ?? '';
  const running = tool.status === 'running';

  const filePathArg: string =
    (typeof tool.args?.path === 'string' && tool.args.path) ||
    (typeof tool.args?.file_path === 'string' && tool.args.file_path) ||
    '';

  return (
    <div className="w-full max-w-full min-w-0 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={cycle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            cycle();
          }
        }}
        title={state === 0 ? (summary ? `${summary} (點擊展開)` : '展開指令') : state === 1 ? '顯示輸出' : '收合'}
        className="w-full py-1 flex items-center space-x-2 text-zinc-300 text-sm text-left font-mono hover:text-zinc-100 transition-colors cursor-pointer select-none"
      >
        <Terminal size={13} className="text-purple-400 shrink-0" />
        <span className="shrink-0 text-purple-400 font-semibold">{tool.name}</span>
        {state === 0 && summary ? (
          filePathArg && onOpenPath ? (
            <>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenPath(filePathArg);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpenPath(filePathArg);
                  }
                }}
                title={filePathArg}
                className="truncate text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer text-left"
              >
                {summary}
              </span>
              <span className="flex-1 min-w-0" />
            </>
          ) : (
            <span className="flex-1 min-w-0 truncate text-zinc-500 text-left" title={summary}>
              {summary}
            </span>
          )
        ) : (
          <span className="flex-1 min-w-0" />
        )}
        <span
          className={`text-xs shrink-0 font-mono ${
            tool.status === 'failed'
              ? 'text-rose-400'
              : running
                ? 'text-amber-400'
                : 'text-emerald-400/80'
          }`}
        >
          {tool.status}
        </span>
        <span className="ml-auto shrink-0 text-zinc-500 pl-1">
          {state === 0 ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </span>
      </div>

      {/* 第一段展開：完整指令／參數 */}
      {state >= 1 && (
        <div className="pl-5 pr-1.5 py-1 text-sm font-mono text-zinc-300 whitespace-pre-wrap break-all max-w-full overflow-x-auto">
          {typeof tool.args?.command === 'string' && (
            <span className="text-emerald-400 select-none">$ </span>
          )}
          {detail}
        </div>
      )}

      {/* 第二段展開：輸出 */}
      {state === 2 && (
        <div className="ml-5 mr-1.5 mb-1 border-l border-[#2a2a30] pl-3 max-w-full">
          {output ? (
            <pre className="max-h-[320px] overflow-auto text-xs leading-[1.55] font-mono text-zinc-400 whitespace-pre-wrap break-words">
              {output}
            </pre>
          ) : (
            <div className="text-xs text-zinc-600 italic">
              {running ? '等待輸出…' : '（沒有輸出）'}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// 取得文字最後一行非空白內容（用於收合思考時顯示最新生成的一行）
const lastLineOf = (text: string): string => {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return '';
};

const MessageItem = React.memo<MessageItemProps>(({
  message,
  userTurnIndex,
  isLoading,
  onInspectSubagent,
  onCopyMessage,
  onSwitchBranch,
  onEditAndResend,
  onRegenerate,
  onForkFromMessage,
  onSetMessageLabel,
  onToggleMessageOmit,
  onOpenPath,
}) => {
  const isUser = message.role === 'user';
  const parts = getMessageParts(message);
  // 每個思考片段的展開狀態各自管理（只重繪本則訊息）
  const [openThinking, setOpenThinking] = useState<Record<string, boolean>>({});
  const toggleThinking = (partKey: string) =>
    setOpenThinking((prev) => ({ ...prev, [partKey]: !prev[partKey] }));

  // 複製狀態提示
  const [copied, setCopied] = useState(false);

  // 原地編輯並重送狀態
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);

  // 書籤標記編輯器狀態
  const [isLabelOpen, setIsLabelOpen] = useState(false);
  const [labelDraft, setLabelDraft] = useState(message.label || '');

  useEffect(() => {
    setEditText(message.content);
  }, [message.content]);

  useEffect(() => {
    setLabelDraft(message.label || '');
  }, [message.label]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onCopyMessage) {
      onCopyMessage(message.content);
    } else {
      navigator.clipboard?.writeText(message.content).catch(() => {});
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditText(message.content);
    setIsLabelOpen(false);
    setIsEditing(true);
  };

  const handleConfirmEdit = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const trimmed = editText.trim();
    if (!trimmed || isLoading) return;
    setIsEditing(false);
    onEditAndResend?.(message, trimmed, userTurnIndex);
  };

  const handleSaveLabel = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const trimmed = labelDraft.trim();
    setIsLabelOpen(false);
    onSetMessageLabel?.(message, trimmed || undefined, userTurnIndex);
  };

  const handleRemoveLabel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setLabelDraft('');
    setIsLabelOpen(false);
    onSetMessageLabel?.(message, undefined, userTurnIndex);
  };

  const branchCount = message.branchCount ?? 1;
  const branchIndex = message.branchIndex ?? 0;
  const siblingLeafIds = message.siblingLeafIds ?? [];

  const handlePrevBranch = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (branchIndex <= 0 || isLoading) return;
    const targetLeafId = siblingLeafIds[branchIndex - 1];
    if (targetLeafId) onSwitchBranch?.(message, targetLeafId);
  };

  const handleNextBranch = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (branchIndex >= branchCount - 1 || isLoading) return;
    const targetLeafId = siblingLeafIds[branchIndex + 1];
    if (targetLeafId) onSwitchBranch?.(message, targetLeafId);
  };

  return (
    <div
      className={`group/msg flex space-x-3 max-w-4xl mx-auto transition-opacity w-full min-w-0 ${
        isUser ? 'justify-end' : 'justify-start'
      } ${message.omitted ? 'opacity-50' : ''}`}
    >
      {!isUser && (
        <div className="w-7 h-7 rounded-lg bg-indigo-900/60 border border-indigo-700/50 flex items-center justify-center shrink-0 mt-0.5 text-indigo-300 shadow-sm">
          <Bot size={16} />
        </div>
      )}

      <div className={`flex flex-col space-y-1.5 min-w-0 ${isUser ? 'max-w-[85%] items-end' : 'flex-1 min-w-0 items-stretch w-full'}`}>
        {/* 若使用者訊息有書籤標記，顯示於對話框右上角 */}
        {isUser && message.label && !isLabelOpen && (
          <div className="flex items-center space-x-1 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[11px] font-medium">
            <Bookmark size={11} className="fill-amber-400/40 text-amber-400 shrink-0" />
            <span className="truncate max-w-[200px]">{message.label}</span>
          </div>
        )}

        {/* 使用者訊息原地編輯模式 */}
        {isUser && isEditing ? (
          <div className="w-full min-w-[300px] sm:min-w-[440px] rounded-xl bg-zinc-900 border border-indigo-500/60 p-3 shadow-lg space-y-2">
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setIsEditing(false);
                } else if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleConfirmEdit();
                }
              }}
              rows={Math.min(8, Math.max(2, editText.split('\n').length))}
              autoFocus
              className="w-full bg-zinc-950/70 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500/60 resize-y font-sans leading-relaxed"
            />
            <div className="flex items-center justify-end space-x-1">
              <IconTipButton
                icon={<X size={14} />}
                tooltip="取消編輯 (Esc)"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsEditing(false);
                }}
              />
              <IconTipButton
                icon={<Send size={14} />}
                tooltip="建立新分支並重新發送 (Enter)"
                disabled={!editText.trim() || isLoading}
                active
                activeClassName="text-white bg-indigo-600 hover:bg-indigo-500 border-indigo-500/80"
                onClick={(e) => handleConfirmEdit(e)}
              />
            </div>
          </div>
        ) : (
          /* 依實際發生順序逐一片段渲染：思考 / 文字 / 工具 / 子代理交錯呈現 */
          parts.map((part, index) => {
            if (part.type === 'thinking') {
              const partKey = `${message.id}:${index}`;
              const isOpen = !!openThinking[partKey];
              // 收合時顯示最新生成的一行，讓使用者看到思考正在進行
              const preview = lastLineOf(part.text);
              return (
                <div
                  key={partKey}
                  className="w-full max-w-full min-w-0 overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => toggleThinking(partKey)}
                    className="w-full py-1 flex items-center space-x-2 text-zinc-300 text-sm text-left font-mono hover:text-zinc-100 transition-colors"
                  >
                    <Sparkles size={13} className="text-amber-400 shrink-0" />
                    <span className="shrink-0 text-amber-400 font-semibold">Thinking</span>
                    {!isOpen && preview && (
                      <span className="flex-1 min-w-0 truncate text-zinc-500 text-left" title={preview}>
                        {preview}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-zinc-500 pl-1">
                      {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="pl-5 pr-1.5 py-1 text-zinc-400 font-sans text-sm leading-relaxed whitespace-pre-wrap">
                      {part.text}
                    </div>
                  )}
                </div>
              );
            }

            if (part.type === 'text') {
              return isUser ? (
                <div
                  key={index}
                  className={`px-4 py-3 rounded-xl text-sm leading-relaxed whitespace-pre-wrap shadow-sm select-text bg-zinc-800 text-zinc-100 rounded-br-xs border ${
                    message.omitted
                      ? 'border-amber-500/40 line-through decoration-zinc-500/50'
                      : 'border-zinc-700/60'
                  }`}
                >
                  {part.text}
                </div>
              ) : (
                <Markdown key={index} onOpenPath={onOpenPath}>
                  {part.text}
                </Markdown>
              );
            }

            if (part.type === 'subagent') {
              return (
                <SubagentCard
                  key={`${message.id}:sub:${part.task.id}`}
                  task={part.task}
                  onInspect={onInspectSubagent}
                />
              );
            }

            if (part.type === 'tool') {
              // 修改檔案的工具（edit / write）改用可展開的 diff 卡片
              if (isFileEditTool(part.tool)) {
                return (
                  <DiffToolCard
                    key={`${message.id}:tool:${part.tool.id}`}
                    tool={part.tool}
                    onOpenPath={onOpenPath}
                  />
                );
              }
              return (
                <ToolCallCard
                  key={`${message.id}:tool:${part.tool.id}`}
                  tool={part.tool}
                  onOpenPath={onOpenPath}
                />
              );
            }

            return null;
          })
        )}

        {/* 書籤標記編輯列 */}
        {isUser && isLabelOpen && !isEditing && (
          <div className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-700/80 shadow-lg">
            <Bookmark size={13} className="text-amber-400 shrink-0" />
            <input
              type="text"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSaveLabel();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setIsLabelOpen(false);
                }
              }}
              placeholder="輸入書籤名稱..."
              autoFocus
              className="bg-zinc-950/80 border border-zinc-800 rounded px-2 py-0.5 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/60 w-40"
            />
            <IconTipButton
              icon={<Check size={13} />}
              tooltip="儲存書籤 (Enter)"
              active
              activeClassName="text-emerald-300 bg-emerald-500/15 border-emerald-500/30"
              onClick={(e) => handleSaveLabel(e)}
            />
            {message.label && (
              <IconTipButton
                icon={<Trash2 size={13} />}
                tooltip="移除書籤"
                danger
                onClick={handleRemoveLabel}
              />
            )}
            <IconTipButton
              icon={<X size={13} />}
              tooltip="取消 (Esc)"
              onClick={(e) => {
                e.stopPropagation();
                setIsLabelOpen(false);
              }}
            />
          </div>
        )}

        {/* 使用者對話框角落的操作按鈕列（全 Icon + Tooltip，無文字、無表情符號） */}
        {isUser && !isEditing && (
          <div className="flex items-center justify-end gap-0.5 pt-0.5 opacity-60 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity select-none">
            {/* 平行分支切換器 (< 1 / N >) */}
            {branchCount > 1 && (
              <div className="flex items-center space-x-0.5 mr-1 px-1 py-0.5 rounded-md bg-zinc-900/90 border border-zinc-800/90">
                <IconTipButton
                  icon={<ChevronLeft size={13} />}
                  tooltip="切換至上一個平行分支"
                  disabled={branchIndex <= 0 || isLoading}
                  onClick={handlePrevBranch}
                  className="!p-1"
                />
                <span className="px-1 text-[11px] font-mono text-zinc-300">
                  {branchIndex + 1} / {branchCount}
                </span>
                <IconTipButton
                  icon={<ChevronRight size={13} />}
                  tooltip="切換至下一個平行分支"
                  disabled={branchIndex >= branchCount - 1 || isLoading}
                  onClick={handleNextBranch}
                  className="!p-1"
                />
              </div>
            )}

            {/* 1. 複製訊息 */}
            <IconTipButton
              icon={copied ? <Check size={13} /> : <Copy size={13} />}
              tooltip={copied ? '已複製訊息內容' : '複製訊息內容'}
              active={copied}
              activeClassName="text-emerald-400 bg-emerald-500/15 border-emerald-500/30"
              onClick={handleCopy}
            />

            {/* 2. 原地編輯並重送（建立新分支） */}
            <IconTipButton
              icon={<Pencil size={13} />}
              tooltip="編輯訊息並重新發送（自動建立新分支）"
              disabled={isLoading}
              onClick={handleStartEdit}
            />

            {/* 3. 重新生成此輪回應 */}
            <IconTipButton
              icon={<RotateCcw size={13} />}
              tooltip="重新生成此輪 AI 回應（建立新分支）"
              disabled={isLoading}
              onClick={(e) => {
                e.stopPropagation();
                onRegenerate?.(message, userTurnIndex);
              }}
            />

            {/* 4. 從此輪對話分叉出獨立的新對話檔 (Fork) */}
            <IconTipButton
              icon={<GitBranch size={13} />}
              tooltip="從此處分叉為獨立的新對話 (Fork Session)"
              disabled={isLoading}
              onClick={(e) => {
                e.stopPropagation();
                onForkFromMessage?.(message, userTurnIndex);
              }}
            />

            {/* 5. 標記書籤 (Label) */}
            <IconTipButton
              icon={<Bookmark size={13} />}
              tooltip={message.label ? `編輯書籤：${message.label}` : '標記書籤 (Bookmark)'}
              active={!!message.label || isLabelOpen}
              activeClassName="text-amber-400 bg-amber-500/15 border-amber-500/30"
              onClick={(e) => {
                e.stopPropagation();
                setLabelDraft(message.label || '');
                setIsLabelOpen((prev) => !prev);
              }}
            />

            {/* 6. 從 AI 上下文中隱藏 / 恢復此輪訊息 (Context Omit) */}
            <IconTipButton
              icon={message.omitted ? <Eye size={13} /> : <EyeOff size={13} />}
              tooltip={
                message.omitted
                  ? '此輪已從 AI 上下文隱藏 — 點擊恢復納入上下文'
                  : '從 AI 上下文中隱藏此輪對話（節省 Token、不刪除紀錄）'
              }
              active={!!message.omitted}
              activeClassName="text-amber-400 bg-amber-500/15 border-amber-500/30"
              disabled={isLoading}
              onClick={(e) => {
                e.stopPropagation();
                onToggleMessageOmit?.(message, userTurnIndex);
              }}
            />
          </div>
        )}
      </div>

      {isUser && (
        <div className="w-7 h-7 rounded-lg bg-zinc-700/60 border border-zinc-600/50 flex items-center justify-center shrink-0 mt-0.5 text-zinc-300 shadow-sm">
          <User size={16} />
        </div>
      )}
    </div>
  );
});

MessageItem.displayName = 'MessageItem';

/* ------------------------------------------------------------------ */
/* 底部輸入框：獨立管理輸入狀態，打字時只重繪此元件                      */
/* ------------------------------------------------------------------ */
interface ChatInputProps {
  isLoading: boolean;
  onSendMessage: (text: string) => void;
  onStop: () => void;
}

const ChatInput = React.memo<ChatInputProps>(({ isLoading, onSendMessage, onStop }) => {
  const [inputText, setInputText] = useState('');

  const submit = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;
    onSendMessage(text);
    setInputText('');
  }, [inputText, onSendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (inputText.trim() && !isLoading) {
        submit();
      }
    }
  };

  return (
    <div className="p-3 border-t border-[#27272a] bg-[#141416]">
      <div className="max-w-4xl mx-auto">
        <div className="relative rounded-xl border border-zinc-700/60 bg-zinc-900/90 focus-within:border-indigo-500/70 focus-within:ring-1 focus-within:ring-indigo-500/30 transition shadow-lg">
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="輸入問題或指令給 Pi Agent (Shift+Enter 換行，Enter 送出)..."
            rows={3}
            className="w-full bg-transparent p-3 pb-9 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none resize-none font-sans"
          />

          {/* 輸入框底部的按鈕 */}
          <div className="absolute bottom-2.5 right-3 flex items-center space-x-2">
            {isLoading ? (
              <button
                onClick={onStop}
                className="px-3 py-1.5 rounded-lg bg-rose-600/80 hover:bg-rose-600 text-white text-sm font-medium flex items-center space-x-1.5 transition shadow"
              >
                <Square size={12} fill="white" />
                <span>停止</span>
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!inputText.trim()}
                className="p-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 text-white transition shadow"
              >
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

ChatInput.displayName = 'ChatInput';

/* ------------------------------------------------------------------ */
/* ChatArea 主體                                                       */
/* ------------------------------------------------------------------ */
export const ChatArea: React.FC<ChatAreaProps> = ({
  messages,
  isLoading,
  onSendMessage,
  onStop,
  onInspectSubagent,
  projectName = 'pi-ui',
  projectPath = 'c:\\aa-project\\pi-ui',
  conversationId,
  modelInfo,
  thinkingLevel,
  onOpenModelSettings,
  onCopyMessage,
  onSwitchBranch,
  onEditAndResend,
  onRegenerate,
  onForkFromMessage,
  onSetMessageLabel,
  onToggleMessageOmit,
  onOpenPath,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  // 使用者是否貼齊底部（決定是否自動跟隨新內容）
  const stickToBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
    stickToBottomRef.current = near;
    setShowScrollButton((prev) => (prev === !near ? prev : !near));
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    stickToBottomRef.current = true;
    setShowScrollButton(false);
  }, []);

  // 切換對話時重置跟隨狀態並直接跳到底部
  useEffect(() => {
    stickToBottomRef.current = true;
    setShowScrollButton(false);
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
  }, [conversationId]);

  // 有新內容時，只有在使用者仍貼齊底部才自動追到底；一旦往上捲就停止跟隨
  useEffect(() => {
    if (stickToBottomRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    }
  }, [messages, isLoading]);

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col bg-[#121214] text-zinc-100 overflow-hidden">
      {/* 頂部會話導航列 */}
      <header className="h-14 border-b border-[#27272a] px-4 flex items-center justify-between bg-[#141416] select-none">
        <div
          className="flex items-center text-xs text-zinc-500 font-mono truncate max-w-md select-text"
          title={projectPath || projectName}
        >
          {projectPath || projectName}
        </div>

        <div className="flex items-center space-x-3 text-sm">
          {/* 模型與推論參數設定按鈕 (簡潔乾淨圖示) */}
          <button
            onClick={onOpenModelSettings}
            title="調整模型與細項參數 (Max Tokens, Thinking Effort 等)"
            className="flex items-center space-x-2 px-2.5 py-1 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 border border-zinc-700/60 text-zinc-200 transition text-xs font-medium group shadow-sm"
          >
            <Cpu size={13} className="text-indigo-400 group-hover:text-indigo-300 transition" />
            <span className="font-mono text-zinc-300 truncate max-w-[180px]">
              {modelInfo || '模型載入中'}
            </span>
            {thinkingLevel && thinkingLevel !== 'off' && (
              <span className="flex items-center space-x-1 text-[11px] px-1.5 py-0.2 rounded bg-indigo-950/80 border border-indigo-800/60 text-indigo-300 font-mono">
                <Brain size={11} className="text-indigo-400" />
                <span>{thinkingLevel}</span>
              </span>
            )}
            <Sliders size={12} className="text-zinc-400 group-hover:text-zinc-200 transition ml-0.5" />
          </button>

          <div className="flex items-center space-x-1.5 pl-2 border-l border-zinc-800 text-zinc-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span className="text-xs font-mono">Active</span>
          </div>
        </div>
      </header>

      {/* 對話訊息列表 */}
      <div className="relative flex-1 flex flex-col min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-5 py-5 space-y-4"
        >
        {/* 空狀態：引導使用者從左側開啟對話 */}
        {messages.length === 0 && !isLoading && (
          <div className="h-full flex flex-col items-center justify-center text-center select-none">
            <div className="w-12 h-12 rounded-2xl bg-indigo-900/40 border border-indigo-700/40 flex items-center justify-center text-indigo-300 mb-4">
              <MessageSquare size={22} />
            </div>
            <h2 className="text-base font-medium text-zinc-200 mb-1.5">選擇一個對話開始</h2>
            <p className="text-sm text-zinc-500 max-w-xs leading-relaxed">
              從左側清單開啟歷史對話，或直接在下方輸入訊息來開始全新對話。
            </p>
          </div>
        )}

        {(() => {
          let currentUserTurnIndex = -1;
          return messages.map((message) => {
            if (message.role === 'user') {
              currentUserTurnIndex += 1;
            }
            const turnIdx = currentUserTurnIndex;
            return (
              <MessageItem
                key={message.id}
                message={message}
                userTurnIndex={turnIdx}
                isLoading={isLoading}
                onInspectSubagent={onInspectSubagent}
                onCopyMessage={onCopyMessage}
                onSwitchBranch={onSwitchBranch}
                onEditAndResend={onEditAndResend}
                onRegenerate={onRegenerate}
                onForkFromMessage={onForkFromMessage}
                onSetMessageLabel={onSetMessageLabel}
                onToggleMessageOmit={onToggleMessageOmit}
                onOpenPath={onOpenPath}
              />
            );
          });
        })()}

        </div>

        {/* 不在最下方時才顯示「回到最下面」懸浮按鈕 */}
        {showScrollButton && (
          <button
            onClick={() => scrollToBottom()}
            title="回到最下面"
            className="absolute bottom-4 right-6 z-10 w-8 h-8 rounded-full bg-zinc-800/90 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 shadow-lg flex items-center justify-center transition"
          >
            <ArrowDown size={16} />
          </button>
        )}
      </div>

      {/* 底部輸入區域（獨立元件，避免打字觸發訊息列表重繪） */}
      <ChatInput
        isLoading={isLoading}
        onSendMessage={onSendMessage}
        onStop={onStop}
      />
    </div>
  );
};
