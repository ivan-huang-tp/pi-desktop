import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send,
  Terminal,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Bot,
  User,
  Square,
  ArrowDown,
  MessageSquare,
  Cpu,
  Brain,
  Sliders
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
}

/* ------------------------------------------------------------------ */
/* 單一訊息列：以 React.memo 包裝，只有該訊息或展開狀態改變時才重繪      */
/* ------------------------------------------------------------------ */
interface MessageItemProps {
  message: Message;
  onInspectSubagent?: (task: SubagentTask) => void;
}

/* ------------------------------------------------------------------ */
/* 工具呼叫卡片：獨立元件，供有序片段渲染使用                            */
/* ------------------------------------------------------------------ */
// 工具參數摘要（收合時單行顯示）
const toolSummary = (tool: ToolCall): string => {
  const a = tool.args || {};
  if (typeof a.command === 'string') return a.command;
  if (typeof a.path === 'string') return a.path;
  if (typeof a.file_path === 'string') return a.file_path;
  return JSON.stringify(a);
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
const ToolCallCard: React.FC<{ tool: ToolCall }> = ({ tool }) => {
  const [state, setState] = useState(0);
  const cycle = () => setState((s) => (s + 1) % 3);

  const summary = toolSummary(tool);
  const detail = toolDetail(tool);
  const output = tool.output ?? '';
  const running = tool.status === 'running';

  return (
    <div className="overflow-hidden">
      <button
        onClick={cycle}
        title={state === 0 ? '展開指令' : state === 1 ? '顯示輸出' : '收合'}
        className="w-full py-1 flex items-center space-x-2 text-zinc-300 text-sm text-left font-mono"
      >
        <Terminal size={13} className="text-zinc-600 shrink-0" />
        <span className="text-purple-400 font-semibold shrink-0">{tool.name}</span>
        {state === 0 ? (
          <span className="flex-1 min-w-0 truncate text-zinc-400">{summary}</span>
        ) : (
          <span className="flex-1" />
        )}
        <span
          className={`text-xs shrink-0 ${
            tool.status === 'failed'
              ? 'text-rose-400'
              : running
                ? 'text-amber-400'
                : 'text-emerald-400'
          }`}
        >
          {tool.status}
        </span>
        <span className="shrink-0">
          {state === 0 ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </span>
      </button>

      {/* 第一段展開：完整指令／參數 */}
      {state >= 1 && (
        <div className="pl-5 pr-1.5 py-1 text-sm font-mono text-zinc-300 whitespace-pre-wrap break-all">
          {typeof tool.args?.command === 'string' && (
            <span className="text-emerald-400 select-none">$ </span>
          )}
          {detail}
        </div>
      )}

      {/* 第二段展開：輸出 */}
      {state === 2 && (
        <div className="ml-5 mr-1.5 mb-1 border-l border-[#2a2a30] pl-3">
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
  onInspectSubagent,
}) => {
  const isUser = message.role === 'user';
  const parts = getMessageParts(message);
  // 每個思考片段的展開狀態各自管理（只重繪本則訊息）
  const [openThinking, setOpenThinking] = useState<Record<string, boolean>>({});
  const toggleThinking = (partKey: string) =>
    setOpenThinking((prev) => ({ ...prev, [partKey]: !prev[partKey] }));

  return (
    <div
      className={`flex space-x-3 max-w-4xl mx-auto ${
        isUser ? 'justify-end' : 'justify-start'
      }`}
    >
      {!isUser && (
        <div className="w-7 h-7 rounded-lg bg-indigo-900/60 border border-indigo-700/50 flex items-center justify-center shrink-0 mt-0.5 text-indigo-300 shadow-sm">
          <Bot size={16} />
        </div>
      )}

      <div className={`space-y-1.5 min-w-0 ${isUser ? 'max-w-[85%] items-end' : 'flex-1 items-start'}`}>
        {/* 依實際發生順序逐一片段渲染：思考 / 文字 / 工具 / 子代理交錯呈現 */}
        {parts.map((part, index) => {
          if (part.type === 'thinking') {
            const partKey = `${message.id}:${index}`;
            const isOpen = !!openThinking[partKey];
            // 收合時顯示最新生成的一行，讓使用者看到思考正在進行
            const preview = lastLineOf(part.text);
            return (
              <div
                key={partKey}
                className="overflow-hidden"
              >
                <button
                  onClick={() => toggleThinking(partKey)}
                  className="w-full py-1 flex items-center space-x-2 text-zinc-300 text-sm text-left font-mono"
                >
                  <Sparkles size={13} className="text-amber-400 shrink-0" />
                  <span className="shrink-0">Thinking Process</span>
                  {!isOpen && preview && (
                    <span className="flex-1 min-w-0 truncate text-zinc-500 text-left">
                      {preview}
                    </span>
                  )}
                  <span className="ml-auto shrink-0">
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
                className="px-4 py-3 rounded-xl text-sm leading-relaxed whitespace-pre-wrap shadow-sm select-text bg-zinc-800 text-zinc-100 rounded-br-xs border border-zinc-700/60"
              >
                {part.text}
              </div>
            ) : (
              <Markdown key={index}>{part.text}</Markdown>
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
              return <DiffToolCard key={`${message.id}:tool:${part.tool.id}`} tool={part.tool} />;
            }
            return <ToolCallCard key={`${message.id}:tool:${part.tool.id}`} tool={part.tool} />;
          }

          return null;
        })}
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

          {/* 輸入框底部的工具列與按鈕 */}
          <div className="absolute bottom-2.5 left-3 right-3 flex items-center justify-between">
            <div className="flex items-center space-x-2 text-xs text-zinc-500">
              <span className="px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700/50 font-mono">
                pi --mode rpc
              </span>
              <span>支援 Subagents & Skills</span>
            </div>

            <div className="flex items-center space-x-2">
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
        <div className="flex items-center space-x-2 text-sm">
          <span className="font-semibold text-zinc-300">Workspace:</span>
          <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono text-xs">
            {projectName}
          </span>
          <span className="text-zinc-600">/</span>
          <span className="text-zinc-400 font-mono truncate max-w-sm text-xs">
            {projectPath}
          </span>
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

        {messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            onInspectSubagent={onInspectSubagent}
          />
        ))}

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
