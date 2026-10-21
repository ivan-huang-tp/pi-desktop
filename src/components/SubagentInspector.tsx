import React, { useState } from 'react';
import { 
  Bot, 
  Terminal, 
  Search, 
  Sparkles, 
  Wrench, 
  ShieldAlert, 
  CheckCircle2, 
  Loader2, 
  XCircle,
  FileText
} from 'lucide-react';
import type { SubagentTask } from '../types';

interface SubagentInspectorProps {
  subagents: SubagentTask[];
  selectedSubagentId?: string;
  onSelectSubagent: (id: string) => void;
}

export const SubagentInspector: React.FC<SubagentInspectorProps> = ({
  subagents,
  selectedSubagentId,
  onSelectSubagent,
}) => {
  const currentSubagent = subagents.find((s) => s.id === selectedSubagentId) || subagents[0];

  const getAgentIcon = (agent: string) => {
    switch (agent.toLowerCase()) {
      case 'scout':
        return <Search size={14} className="text-purple-400" />;
      case 'planner':
        return <Sparkles size={14} className="text-blue-400" />;
      case 'reviewer':
        return <ShieldAlert size={14} className="text-amber-400" />;
      default:
        return <Wrench size={14} className="text-emerald-400" />;
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#121214] overflow-hidden select-text">
      {/* 頂部標題 */}
      <div className="h-10 px-2 bg-[#18181b] border-b border-[#27272a] flex items-center justify-between text-sm text-zinc-400 select-none">
        <span className="font-mono text-zinc-300 font-medium">Subagents Inspector</span>
        <span className="text-xs text-zinc-500">
          {subagents.length} Agent{subagents.length > 1 ? 's' : ''} Active
        </span>
      </div>

      {subagents.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-5 text-center text-zinc-500 text-sm">
          <Bot size={28} className="mb-2 opacity-40 text-zinc-400" />
          <p>目前尚未指派 Subagent</p>
          <p className="mt-1 text-xs text-zinc-600">
            當主 Agent 呼叫 scout、planner 或 worker 時，此處會顯示獨立執行紀錄。
          </p>
        </div>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Subagent 水平切換標籤 */}
          <div className="flex items-center space-x-1 p-2 bg-[#151518] border-b border-zinc-800/80 overflow-x-auto select-none">
            {subagents.map((agent) => {
              const isSelected = agent.id === (currentSubagent?.id);
              return (
                <button
                  key={agent.id}
                  onClick={() => onSelectSubagent(agent.id)}
                  className={`flex items-center space-x-1.5 px-2.5 py-1 rounded text-sm transition shrink-0 ${
                    isSelected
                      ? 'bg-zinc-800 text-zinc-100 font-medium border border-zinc-700/80'
                      : 'text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200'
                  }`}
                >
                  {getAgentIcon(agent.agent)}
                  <span className="capitalize">{agent.agent}</span>
                  {agent.status === 'running' && (
                    <Loader2 size={11} className="animate-spin text-amber-400" />
                  )}
                  {agent.status === 'completed' && (
                    <CheckCircle2 size={11} className="text-emerald-400" />
                  )}
                </button>
              );
            })}
          </div>

          {/* 目前選中 Subagent 的詳細紀錄 */}
          {currentSubagent && (
            <div className="flex-1 overflow-y-auto p-2 space-y-2.5">
              {/* 任務摘要卡片 */}
              <div className="p-3 rounded-lg bg-zinc-900/80 border border-zinc-800 text-sm space-y-1.5">
                <div className="flex items-center justify-between text-zinc-400 text-xs">
                  <span>子任務指派 (Isolated Context):</span>
                  <span className="font-mono text-emerald-400">{currentSubagent.tokensUsed || 0} tokens</span>
                </div>
                <div className="text-zinc-200 font-medium">
                  {currentSubagent.task}
                </div>
              </div>

              {/* 專屬 Terminal Logs */}
              <div>
                <div className="text-xs font-semibold text-zinc-400 mb-1.5 flex items-center space-x-1.5 select-none">
                  <Terminal size={12} className="text-emerald-400" />
                  <span>Subagent 終端機執行 Log：</span>
                </div>
                <div className="p-2.5 rounded bg-black/70 border border-zinc-800/90 font-mono text-xs text-zinc-300 leading-relaxed overflow-x-auto max-h-56">
                  {currentSubagent.terminalLogs && currentSubagent.terminalLogs.length > 0 ? (
                    currentSubagent.terminalLogs.map((log, idx) => (
                      <div key={idx} className="whitespace-pre-wrap">{log}</div>
                    ))
                  ) : (
                    <span className="text-zinc-600">// 無獨立終端機輸出</span>
                  )}
                </div>
              </div>

              {/* 回報總結 */}
              {currentSubagent.output && (
                <div>
                  <div className="text-xs font-semibold text-zinc-400 mb-1.5 flex items-center space-x-1.5 select-none">
                    <FileText size={12} className="text-blue-400" />
                    <span>回報主代理的結論：</span>
                  </div>
                  <div className="p-3 rounded bg-zinc-900/80 border border-zinc-800 text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap font-sans">
                    {currentSubagent.output}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
