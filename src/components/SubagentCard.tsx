import React, { useState } from 'react';
import { 
  Bot, 
  ChevronDown, 
  ChevronRight, 
  CheckCircle2, 
  Loader2, 
  XCircle, 
  Terminal, 
  FileCode2, 
  Eye, 
  Sparkles,
  Search,
  Wrench,
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
  const getAgentTheme = (agent: string) => {
    switch (agent.toLowerCase()) {
      case 'scout':
        return {
          badge: 'bg-purple-900/40 text-purple-300 border-purple-700/50',
          border: 'border-purple-800/40 hover:border-purple-700/60',
          icon: <Search size={14} className="text-purple-400" />,
          label: 'Scout 偵察代理',
        };
      case 'planner':
        return {
          badge: 'bg-blue-900/40 text-blue-300 border-blue-700/50',
          border: 'border-blue-800/40 hover:border-blue-700/60',
          icon: <Sparkles size={14} className="text-blue-400" />,
          label: 'Planner 規劃代理',
        };
      case 'reviewer':
        return {
          badge: 'bg-amber-900/40 text-amber-300 border-amber-700/50',
          border: 'border-amber-800/40 hover:border-amber-700/60',
          icon: <ShieldAlert size={14} className="text-amber-400" />,
          label: 'Reviewer 審查代理',
        };
      default:
        return {
          badge: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50',
          border: 'border-emerald-800/40 hover:border-emerald-700/60',
          icon: <Wrench size={14} className="text-emerald-400" />,
          label: `${task.agent} 執行代理`,
        };
    }
  };

  const theme = getAgentTheme(task.agent);

  return (
    <div className={`my-1 rounded-lg border bg-zinc-900/70 overflow-hidden transition ${theme.border}`}>
      {/* 頂部標題列 */}
      <div 
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center justify-between px-3 py-2 cursor-pointer bg-zinc-900/90 hover:bg-zinc-800/60 transition"
      >
        <div className="flex items-center space-x-2.5 min-w-0">
          {/* Agent 角色 Badge */}
          <div className={`flex items-center space-x-1.5 px-2 py-0.5 rounded text-sm font-medium border ${theme.badge}`}>
            {theme.icon}
            <span className="capitalize">{task.agent}</span>
          </div>

          {/* 任務摘要 */}
          <span className="text-sm text-zinc-300 font-medium truncate">
            {task.task}
          </span>
        </div>

        {/* 狀態指示與右側按鈕 */}
        <div className="flex items-center space-x-3 ml-2 shrink-0">
          {task.status === 'running' && (
            <div className="flex items-center space-x-1.5 text-sm text-amber-400">
              <Loader2 size={13} className="animate-spin" />
              <span>運行中</span>
            </div>
          )}
          {task.status === 'completed' && (
            <div className="flex items-center space-x-1 text-sm text-emerald-400">
              <CheckCircle2 size={13} />
              <span>完成</span>
            </div>
          )}
          {task.status === 'failed' && (
            <div className="flex items-center space-x-1 text-sm text-rose-400">
              <XCircle size={13} />
              <span>失敗</span>
            </div>
          )}

          {/* 深入檢視按鈕（在右側面板打開專屬 Terminal） */}
          {onInspect && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onInspect(task);
              }}
              title="在右側面板檢視此 Subagent 的終端機日誌"
              className="text-sm text-zinc-400 hover:text-zinc-100 px-2 py-0.5 rounded hover:bg-zinc-700/50 flex items-center space-x-1 transition"
            >
              <Eye size={12} />
              <span>檢視日誌</span>
            </button>
          )}

          {/* 折疊圖示 */}
          <button className="text-zinc-400 hover:text-zinc-200">
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </div>
      </div>

      {/* 展開後的詳細內容（思考過程、內部工具調用、產出） */}
      {isExpanded && (
        <div className="px-3.5 py-2.5 bg-[#151518] text-sm border-t border-zinc-800/80 space-y-2.5 font-mono">
          {/* 思考過程 */}
          {task.thinking && (
            <div>
              <div className="text-xs font-semibold text-zinc-400 mb-1 flex items-center space-x-1">
                <span>💭 子代理思考過程：</span>
              </div>
              <div className="p-2.5 rounded bg-zinc-900/80 border border-zinc-800 text-zinc-300 font-sans text-sm leading-relaxed whitespace-pre-wrap">
                {task.thinking}
              </div>
            </div>
          )}

          {/* 工具調用時間軸 */}
          {task.tools && task.tools.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-zinc-400 mb-1 flex items-center space-x-1">
                <Terminal size={12} />
                <span>內部調用動作 ({task.tools.length})：</span>
              </div>
              <div className="space-y-1.5 pl-2 border-l border-zinc-800">
                {task.tools.map((tool, idx) => (
                  <div key={idx} className="flex items-start space-x-2 text-zinc-300">
                    <span className="text-zinc-500">•</span>
                    <span className="text-purple-400 font-semibold">{tool.name}</span>
                    <span className="text-zinc-400 truncate">
                      {tool.args ? JSON.stringify(tool.args) : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 產出結論 */}
          {task.output && (
            <div>
              <div className="text-xs font-semibold text-zinc-400 mb-1 flex items-center space-x-1">
                <FileCode2 size={12} />
                <span>回報結果：</span>
              </div>
              <div className="p-2.5 rounded bg-zinc-900/90 border border-zinc-800 text-zinc-200 font-sans leading-relaxed whitespace-pre-wrap">
                {task.output}
              </div>
            </div>
          )}

          {/* 資源消耗統計 */}
          {task.tokensUsed && (
            <div className="pt-2 border-t border-zinc-800/60 text-xs text-zinc-500 flex justify-between">
              <span>Token 消耗: {task.tokensUsed} tokens</span>
              <span className="text-emerald-500/80">獨立 Context Window 已自動釋放</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
