import React, { useState, useMemo, useEffect } from 'react';
import { 
  Folder, 
  FolderPlus, 
  Filter, 
  Plus, 
  ChevronDown, 
  ChevronRight, 
  Settings, 
  Terminal,
  FolderOpen,
  Cpu,
  Server,
  SlidersHorizontal
} from 'lucide-react';
import type { Project, Session, CoreInfo } from '../types';

interface SidebarProps {
  projects: Project[];
  activeSessionId: string;
  onSelectSession: (session: Session, project?: Project) => void;
  onNewSession: (projectId?: string) => void;
  onOpenFolder: () => void;
  onOpenSshModal?: () => void;
  coreInfo?: CoreInfo | null;
  onOpenCoreManager?: () => void;
  onOpenModelSettings?: () => void;
  onOpenAppSettings?: () => void;
  /** 對「對話」按右鍵 */
  onSessionContextMenu?: (session: Session, project: Project, x: number, y: number) => void;
  /** 對「專案」按右鍵 */
  onProjectContextMenu?: (project: Project, x: number, y: number) => void;
  /** 對「空白處」按右鍵 */
  onBlankContextMenu?: (x: number, y: number) => void;
  /** 外部觸發「全部展開 / 全部收合」 */
  expandAllCommand?: { action: 'expand' | 'collapse'; nonce: number } | null;
  /** 側欄寬度 (px)，由 App 控制以支援拖曳調整 */
  width?: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  projects,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onOpenFolder,
  onOpenSshModal,
  coreInfo,
  onOpenCoreManager,
  onOpenModelSettings,
  onOpenAppSettings,
  onSessionContextMenu,
  onProjectContextMenu,
  onBlankContextMenu,
  expandAllCommand,
  width = 256,
}) => {
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});

  // 回應外部「全部展開 / 全部收合」指令
  useEffect(() => {
    if (!expandAllCommand) return;
    const all: Record<string, boolean> = {};
    projects.forEach((p) => { all[p.id] = expandAllCommand.action === 'expand'; });
    setExpandedProjects(all);
    // 僅依 nonce 觸發
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandAllCommand?.nonce]);

  // 找出「最新對話」所在的專案，預設只展開它
  const mostRecentProjectId = useMemo(() => {
    let bestId: string | null = null;
    let bestTime = -1;
    projects.forEach((p) => {
      const t = p.sessions[0]?.updatedAt || 0;
      if (t > bestTime) {
        bestTime = t;
        bestId = p.id;
      }
    });
    return bestId;
  }, [projects]);

  const toggleProject = (projectId: string) => {
    setExpandedProjects((prev) => ({
      ...prev,
      [projectId]: !prev[projectId],
    }));
  };

  return (
    <aside
      style={{ width }}
      className="h-full shrink-0 bg-[#18181b] border-r border-[#27272a] flex flex-col justify-between select-none text-zinc-300 overflow-hidden"
      onContextMenu={(e) => {
        // 只有點在真正的空白處（非對話/專案列）才觸發
        if (e.target === e.currentTarget) {
          e.preventDefault();
          onBlankContextMenu?.(e.clientX, e.clientY);
        }
      }}
    >
      {/* 頂部區域 */}
      <div
        className="flex-1 overflow-y-auto px-1.5 py-1.5"
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            onBlankContextMenu?.(e.clientX, e.clientY);
          }
        }}
      >
        {/* Projects 區塊 */}
        <div className="mb-4">
          <div className="flex items-center justify-between px-2 mb-2 text-[15.5px] font-semibold text-zinc-400">
            <span className="text-[15.5px] font-medium text-zinc-300">Projects</span>
            <div className="flex items-center space-x-1.5">
              <button 
                title="Filter projects" 
                className="hover:text-zinc-100 p-1 rounded hover:bg-zinc-800 transition"
              >
                <Filter size={15} />
              </button>
              <button 
                title="新增 SSH 遠端專案 (Native SSH)" 
                onClick={onOpenSshModal}
                className="text-cyan-400 hover:text-cyan-300 p-1 rounded hover:bg-zinc-800 transition"
              >
                <Server size={15} />
              </button>
              <button 
                title="Open Folder / Add Local Project" 
                onClick={onOpenFolder}
                className="hover:text-zinc-100 p-1 rounded hover:bg-zinc-800 transition"
              >
                <FolderPlus size={16} />
              </button>
            </div>
          </div>

          {/* 專案列表 */}
          <div className="space-y-1">
            {projects.map((project) => {
              // 預設只展開最新對話所在的專案，其餘收合
              const isExpanded = expandedProjects[project.id] ?? (project.id === mostRecentProjectId && !!project.sessions.length);
              return (
                <div key={project.id} className="text-[16.5px]">
                  {/* 專案資料夾名稱 */}
                  <div
                    onClick={() => toggleProject(project.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onProjectContextMenu?.(project, e.clientX, e.clientY);
                    }}
                    title={project.ssh ? `[SSH] ${project.ssh.host}:${project.path}` : project.path}
                    className="flex items-center space-x-2.5 px-2.5 py-1.5 rounded-md cursor-pointer hover:bg-zinc-800/60 transition group text-zinc-300"
                  >
                    {project.ssh ? (
                      <Server size={16} className="text-cyan-400 group-hover:text-cyan-300 shrink-0" />
                    ) : (
                      <Folder size={16} className="text-zinc-400 group-hover:text-zinc-200 shrink-0" />
                    )}
                    <span className="font-medium flex-1 truncate">{project.name}</span>
                    {project.ssh && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-mono shrink-0">
                        SSH
                      </span>
                    )}
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        onNewSession(project.id);
                      }}
                      title="New chat in this project"
                      className="opacity-0 group-hover:opacity-100 hover:text-zinc-100 p-0.5 rounded transition shrink-0"
                    >
                      <Plus size={14} />
                    </button>
                  </div>

                  {/* 專案底下的 Sessions 列表 */}
                  {isExpanded && (
                    <div className="mt-0.5 space-y-1">
                      {project.sessions.map((session) => {
                        const isActive = session.id === activeSessionId;
                        return (
                          <div
                            key={session.id}
                            onClick={() => onSelectSession(session, project)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              onSessionContextMenu?.(session, project, e.clientX, e.clientY);
                            }}
                            title={session.filePath || session.title}
                            className={`flex items-center justify-between px-2.5 py-1.5 rounded-md cursor-pointer text-[16.5px] transition group ${
                              isActive
                                ? 'bg-zinc-700/60 text-zinc-100 font-medium'
                                : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                            }`}
                          >
                            <span className="truncate pr-2">{session.title}</span>
                            <span className="text-[12px] text-zinc-500 whitespace-nowrap group-hover:text-zinc-400">
                              {session.timeAgo}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

      </div>

      {/* 底部工作區狀態 & 核心管理 */}
      <div className="p-3 border-t border-[#27272a] bg-zinc-900/60 text-[15px] flex items-center justify-between text-zinc-400">
        <button
          onClick={onOpenCoreManager}
          title="點擊管理 Pi 核心與檢查更新"
          className="flex items-center space-x-2 truncate hover:text-zinc-200 transition text-left"
        >
          <div 
            className={`w-2 h-2 rounded-full shrink-0 ${
              coreInfo?.type === 'user' ? 'bg-emerald-400' : coreInfo?.type === 'bundled' ? 'bg-blue-400' : 'bg-amber-400'
            }`} 
            title={coreInfo?.description || 'Pi RPC Ready'}
          />
          <div className="truncate flex flex-col">
            <span className="truncate font-mono text-[13px] font-medium text-zinc-200">
              Pi Core v{coreInfo?.version || '1.3.0'}
            </span>
            <span className="text-[13px] text-zinc-500 font-mono">
              {coreInfo?.type === 'user' ? '已更新版' : coreInfo?.type === 'bundled' ? '內建封裝' : '系統全域'}
            </span>
          </div>
        </button>

        <div className="flex items-center space-x-1">
          <button 
            title="模型與細項參數設定" 
            onClick={onOpenModelSettings}
            className="p-1.5 rounded-md hover:bg-zinc-800 hover:text-zinc-200 text-zinc-400 transition"
          >
            <Cpu size={14} />
          </button>
          <button 
            title="程式設定（Trace 記錄、遠端終端機）" 
            onClick={onOpenAppSettings}
            className="p-1.5 rounded-md hover:bg-zinc-800 hover:text-zinc-200 text-zinc-400 transition"
          >
            <SlidersHorizontal size={14} />
          </button>
          <button 
            title="Pi 核心設定與更新" 
            onClick={onOpenCoreManager}
            className="p-1.5 rounded-md hover:bg-zinc-800 hover:text-zinc-200 text-zinc-400 transition"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
};
