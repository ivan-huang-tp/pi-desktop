import React, { useEffect, useState, lazy, Suspense } from 'react';
import { 
  FolderTree, 
  Terminal, 
  Bot, 
} from 'lucide-react';
import { FileTree } from './FileTree';
import { SubagentInspector } from './SubagentInspector';
import type { FileItem, SubagentTask, SshConfig } from '../types';

// 動態延遲載入終端機：App 啟動時完全不載入 xterm，秒開首頁，點進 Terminal 分頁才隨需抓取
const ShellTerminal = lazy(() =>
  import('./ShellTerminal').then((m) => ({ default: m.ShellTerminal }))
);

export type RightPanelTab = 'files' | 'terminal' | 'subagents';

interface RightPanelProps {
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  files: FileItem[];
  currentWorkspace: string;
  ssh?: SshConfig;
  subagents: SubagentTask[];
  selectedSubagentId?: string;
  onSelectSubagent: (id: string) => void;
  refreshTrigger?: number;
  onRefreshFiles?: () => void;
  revealRequest?: { path: string; nonce: number } | null;
  /** 面板寬度 (px)，由 App 控制以支援拖曳調整 */
  width?: number;
}

export const RightPanel: React.FC<RightPanelProps> = ({
  activeTab,
  onTabChange,
  files,
  currentWorkspace,
  ssh,
  subagents,
  selectedSubagentId,
  onSelectSubagent,
  refreshTrigger = 0,
  onRefreshFiles,
  revealRequest,
  width = 384,
}) => {
  // 終端機第一次打開後就保持掛載，切換分頁時 shell 不會被關掉
  const [terminalMounted, setTerminalMounted] = useState(activeTab === 'terminal');
  useEffect(() => {
    if (activeTab === 'terminal') setTerminalMounted(true);
  }, [activeTab]);

  return (
    <aside
      style={{ width }}
      className="h-full shrink-0 bg-[#18181b] border-l border-[#27272a] flex flex-col overflow-hidden select-none"
    >
      {/* 頂部 Tab 切換列 */}
      <div className="h-11 px-1.5 bg-[#151518] border-b border-[#27272a] flex items-center justify-between text-sm text-zinc-400">
        <div className="flex items-center space-x-1">
          {/* Files Tab */}
          <button
            onClick={() => onTabChange('files')}
            className={`flex items-center space-x-1.5 px-2 py-1 rounded transition ${
              activeTab === 'files'
                ? 'bg-zinc-800 text-zinc-100 font-medium'
                : 'hover:bg-zinc-800/40 hover:text-zinc-300'
            }`}
          >
            <FolderTree size={14} className="text-amber-400" />
            <span>Files</span>
          </button>

          {/* Terminal Tab */}
          <button
            onClick={() => onTabChange('terminal')}
            className={`flex items-center space-x-1.5 px-2 py-1 rounded transition relative ${
              activeTab === 'terminal'
                ? 'bg-zinc-800 text-zinc-100 font-medium'
                : 'hover:bg-zinc-800/40 hover:text-zinc-300'
            }`}
          >
            <Terminal size={14} className="text-emerald-400" />
            <span>Terminal</span>
          </button>

          {/* Subagents Tab */}
          <button
            onClick={() => onTabChange('subagents')}
            className={`flex items-center space-x-1.5 px-2 py-1 rounded transition relative ${
              activeTab === 'subagents'
                ? 'bg-zinc-800 text-zinc-100 font-medium'
                : 'hover:bg-zinc-800/40 hover:text-zinc-300'
            }`}
          >
            <Bot size={14} className="text-purple-400" />
            <span>Subagents</span>
            {subagents.some((s) => s.status === 'running') && (
              <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse"></span>
            )}
          </button>
        </div>
      </div>

      {/* 內容區塊 */}
      <div className="flex-1 overflow-hidden">
        <div className="h-full" style={{ display: activeTab === 'files' ? 'block' : 'none' }}>
          <FileTree
            files={files}
            currentWorkspace={currentWorkspace}
            ssh={ssh}
            refreshTrigger={refreshTrigger}
            onRefresh={onRefreshFiles}
            revealRequest={revealRequest}
          />
        </div>

        {/* 使用者終端機：動態延遲載入，保持掛載，僅以 CSS 隱藏 */}
        {terminalMounted && (
          <div className="h-full select-text" style={{ display: activeTab === 'terminal' ? 'block' : 'none' }}>
            <Suspense
              fallback={
                <div className="h-full flex items-center justify-center text-xs text-zinc-500 font-mono">
                  載入終端機中...
                </div>
              }
            >
              <ShellTerminal cwd={currentWorkspace} ssh={ssh} />
            </Suspense>
          </div>
        )}

        {activeTab === 'subagents' && (
          <SubagentInspector
            subagents={subagents}
            selectedSubagentId={selectedSubagentId}
            onSelectSubagent={onSelectSubagent}
          />
        )}
      </div>
    </aside>
  );
};
