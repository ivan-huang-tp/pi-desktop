import React, { useState } from 'react';
import { 
  Bot, 
  ChevronDown, 
  ChevronRight, 
  Loader2, 
  Terminal, 
  FileCode2, 
  Eye, 
  Sparkles,
  Search,
  ShieldAlert
} from 'lucide-react';
import type { SubagentTask } from '../types';

interface SubagentCardProps {
  task: SubagentTask;
  onInspect?: (task: SubagentTask) => void;
}

export const SubagentCard: React.FC<SubagentCardProps> = ({ task, onInspect }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // 根據角色給予專屬的配色與圖示
  const getAgentInfo = (agent: string) => {
    switch (agent.toLowerCase()) {
      case 'scout':
        return {
          icon: <Search size={13} className="text-purple-400 shrink-0" />,
          color: 'text-purple-400',
          label: 'scout',
        };
      case 'planner':
        return {
          icon: <Sparkles size={13} className="text-blue-400 shrink-0" />,
          color: 'text-blue-400',
          label: 'planner',
        };
      case 'reviewer':
        return {
          icon: <ShieldAlert size={13} className="text-amber-400 shrink-0" />,
          color: 'text-amber-400',
          label: 'reviewer',
        };
      default:
        return {
          icon: <Bot size={13} className="text-indigo-400 shrink-0" />,
          color: 'text-indigo-400',
          label: agent || 'subagent',
        };
    }
  };

  const info = getAgentInfo(task.agent);
  const running = task.status === 'running';
  const failed = task.status === 'failed';
  const completed = task.status === 'completed';

  return (
    <div className="w-full max-w-full min-w-0 overflow-hidden">
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        title={isExpanded ? '收合子代理' : '展開子代理詳情'}
        className="w-full py-1 flex items-center space-x-2 text-zinc-300 text-sm text-left font-mono hover:text-zinc-100 transition-colors"
      >
        {info.icon}
        <span className={`shrink-0 ${info.color} font-semibold capitalize`}>
          {info.label}
        </span>
        {task.task ? (
          <span className="flex-1 min-w-0 truncate text-zinc-500 text-left" title={task.task}>
            {task.task}
          </span>
        ) : (
          <span className="flex-1 min-w-0" />
        )}

        {running && (
          <span className="flex items-center space-x-1 text-xs text-amber-400 shrink-0 font-mono">
            <Loader2 size={11} className="animate-spin" />
            <span>運行中</span>
          </span>
        )}
        {completed && (
          <span className="text-xs text-emerald-400/80 shrink-0 font-mono">完成</span>
        )}
        {failed && (
          <span className="text-xs text-rose-400 shrink-0 font-mono">失敗</span>
        )}

        {onInspect && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onInspect(task);
            }}
            title="在右側面板檢視此 Subagent 終端機日誌"
            className="text-xs text-zinc-400 hover:text-zinc-200 px-1 py-0.5 rounded hover:bg-zinc-800 shrink-0 transition flex items-center space-x-0.5 cursor-pointer"
          >
            <Eye size={11} />
            <span>日誌</span>
          </span>
        )}

        <span className="ml-auto shrink-0 text-zinc-500 pl-1">
          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>

      {/* 展開後的詳細內容（思考過程、內部工具調用、產出） */}
      {isExpanded && (
        <div className="ml-5 mr-1.5 mb-1 border-l border-[#2a2a30] pl-3 py-1 space-y-2 text-xs font-mono">
          {/* 思考過程 */}
          {task.thinking && (
            <div>
              <div className="text-zinc-500 select-none mb-0.5">💭 思考過程：</div>
              <div className="text-zinc-400 font-sans leading-relaxed whitespace-pre-wrap">
                {task.thinking}
              </div>
            </div>
          )}

          {/* 工具調用時間軸 */}
          {task.tools && task.tools.length > 0 && (
            <div>
              <div className="text-zinc-500 select-none mb-1 flex items-center space-x-1">
                <Terminal size={11} />
                <span>內部調用動作 ({task.tools.length})：</span>
              </div>
              <div className="space-y-1 pl-1">
                {task.tools.map((tool, idx) => {
                  const argsStr = tool.args ? (typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args)) : '';
                  return (
                    <div key={idx} className="flex items-center space-x-1.5 text-zinc-300 min-w-0">
                      <span className="text-zinc-600 shrink-0">•</span>
                      <span className="text-purple-400 font-semibold shrink-0">{tool.name}</span>
                      <span className="text-zinc-500 truncate flex-1 min-w-0" title={argsStr}>
                        {argsStr}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 產出結論 */}
          {task.output && (
            <div>
              <div className="text-zinc-500 select-none mb-0.5 flex items-center space-x-1">
                <FileCode2 size={11} />
                <span>回報結果：</span>
              </div>
              <div className="text-zinc-300 font-sans leading-relaxed whitespace-pre-wrap">
                {task.output}
              </div>
            </div>
          )}

          {/* 資源消耗統計 */}
          {task.tokensUsed && (
            <div className="pt-1 text-zinc-500 flex justify-between">
              <span>Token 消耗: {task.tokensUsed}</span>
              <span className="text-emerald-500/80">Context 已釋放</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
