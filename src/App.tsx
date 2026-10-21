import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { RightPanel, RightPanelTab } from './components/RightPanel';
import { CoreManagerModal } from './components/CoreManagerModal';
import { ModelSettingsModal } from './components/ModelSettingsModal';
import { SshModal } from './components/SshModal';
import { ContextMenu, ContextMenuItem } from './components/ContextMenu';
import { ResizeHandle } from './components/ResizeHandle';
import {
  Play, Pencil, CopyPlus, Download, FileCode, FileJson, Clipboard as ClipboardIcon,
  Trash2, FolderOpen, Plus, RefreshCw, FolderPlus, ChevronsUpDown, AlertTriangle, Server,
} from 'lucide-react';
import type { Project, Session, Message, FileItem, SubagentTask, ToolCall, CoreInfo, BashCommand, SessionLog, SshConfig } from './types';
import {
  appendAssistantDelta,
  appendToolPart,
  appendSubagentPart,
  updateToolPart,
  updateSubagentPart,
} from './lib/messageParts';

// 從 Pi 的 partialResult / result 取出純文字（content 為 text block 陣列）
const textFromResult = (r: any): string | undefined => {
  if (r == null) return undefined;
  if (typeof r === 'string') return r;
  const content = r.content;
  if (Array.isArray(content)) {
    return content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '').join('');
  }
  return undefined;
};

// 取得 Electron IPC（在 Electron 環境中可用）
const electron = (window as any).require ? (window as any).require('electron') : null;
const ipcRenderer = electron?.ipcRenderer;

// 產生對話用的唯一 id
const uuid = () =>
  typeof crypto !== 'undefined' && (crypto as any).randomUUID
    ? (crypto as any).randomUUID()
    : `x-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// 穩定的空陣列參考，避免每次 render 產生新陣列
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_BASH: BashCommand[] = [];

// 預設工作區（在真實專案載入前，或純網頁預覽模式使用）
const DEFAULT_PROJECT: Project = {
  id: 'default',
  name: 'pi-ui',
  path: 'c:\\aa-project\\pi-ui',
  sessions: [],
};

// --- 三欄式佈局：可拖曳調整寬度的相關設定 ---
const SIDEBAR_DEFAULT = 256; // 等同原本的 w-64
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const RIGHT_PANEL_DEFAULT = 384; // 等同原本的 w-96
const RIGHT_PANEL_MIN = 280;
const RIGHT_PANEL_MAX = 720;
// 中間對話區至少要保留的寬度，避免被兩側擠壓到不可用
const CENTER_MIN = 360;
const PANEL_WIDTH_KEY = 'pi-ui:panel-widths';

export const App: React.FC = () => {
  // 1. Projects & Sessions
  const [projects, setProjects] = useState<Project[]>([DEFAULT_PROJECT]);

  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [currentProject, setCurrentProject] = useState<Project>(DEFAULT_PROJECT);

  // 2. 右側面板狀態
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('files');
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | undefined>();

  // 2b. 三欄寬度（可拖曳調整，並記住上次的設定）
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_WIDTH_KEY) || '{}');
      return Number.isFinite(saved.sidebar) ? saved.sidebar : SIDEBAR_DEFAULT;
    } catch {
      return SIDEBAR_DEFAULT;
    }
  });
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_WIDTH_KEY) || '{}');
      return Number.isFinite(saved.right) ? saved.right : RIGHT_PANEL_DEFAULT;
    } catch {
      return RIGHT_PANEL_DEFAULT;
    }
  });
  // 供拖曳回呼即時讀取兩側目前寬度，計算中間區塊的可用空間
  const panelWidthsRef = useRef({ sidebar: sidebarWidth, right: rightPanelWidth });
  panelWidthsRef.current = { sidebar: sidebarWidth, right: rightPanelWidth };

  const persistPanelWidths = useCallback((sidebar: number, right: number) => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, JSON.stringify({ sidebar, right }));
    } catch {
      /* 忽略無法寫入的情境（例如隱私模式） */
    }
  }, []);

  const handleSidebarResize = useCallback((deltaX: number) => {
    setSidebarWidth((w) => {
      const maxByWindow = window.innerWidth - panelWidthsRef.current.right - CENTER_MIN;
      const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, maxByWindow));
      return Math.min(Math.max(w + deltaX, SIDEBAR_MIN), max);
    });
  }, []);

  const handleRightPanelResize = useCallback((deltaX: number) => {
    // 右欄往左拖（deltaX < 0）會變寬，因此取負號
    setRightPanelWidth((w) => {
      const maxByWindow = window.innerWidth - panelWidthsRef.current.sidebar - CENTER_MIN;
      const max = Math.max(RIGHT_PANEL_MIN, Math.min(RIGHT_PANEL_MAX, maxByWindow));
      return Math.min(Math.max(w - deltaX, RIGHT_PANEL_MIN), max);
    });
  }, []);

  // 視窗縮小到放不下時，自動收斂兩側寬度
  useEffect(() => {
    const onWindowResize = () => {
      setRightPanelWidth((w) => {
        const max = Math.max(
          RIGHT_PANEL_MIN,
          Math.min(RIGHT_PANEL_MAX, window.innerWidth - panelWidthsRef.current.sidebar - CENTER_MIN),
        );
        return Math.min(w, max);
      });
      setSidebarWidth((w) => {
        const max = Math.max(
          SIDEBAR_MIN,
          Math.min(SIDEBAR_MAX, window.innerWidth - panelWidthsRef.current.right - CENTER_MIN),
        );
        return Math.min(w, max);
      });
    };
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
  }, []);

  // 3. 檔案樹與重整觸發器（由 FileTree 自行管理目前瀏覽目錄，此處提供外部觸發重整）
  const [files] = useState<FileItem[]>([]);
  const [fileRefreshTrigger, setFileRefreshTrigger] = useState<number>(0);
  const [revealFileRequest, setRevealFileRequest] = useState<{ path: string; nonce: number } | null>(null);

  // 4. 連線/核心訊息（全域）
  const [sessionLogs, setSessionLogs] = useState<SessionLog[]>([
    { id: 'boot', text: '正在連線至本地 Pi RPC 核心...', ts: Date.now() },
  ]);

  // 5. 每個對話各自獨立的訊息 / 載入中 / 指令紀錄（一個對話 = 一個 Pi 子程序）
  const [activeConvId, setActiveConvId] = useState<string>('');
  const [messagesByConv, setMessagesByConv] = useState<Record<string, Message[]>>({});
  const [loadingByConv, setLoadingByConv] = useState<Record<string, boolean>>({});
  const [bashByConv, setBashByConv] = useState<Record<string, BashCommand[]>>({});

  const messages = messagesByConv[activeConvId] || EMPTY_MESSAGES;
  const isLoading = !!loadingByConv[activeConvId];
  const bashCommands = bashByConv[activeConvId] || EMPTY_BASH;
  const [modelInfo, setModelInfo] = useState<string>('連接中...');
  const [thinkingLevel, setThinkingLevel] = useState<string>('medium');
  const [coreInfo, setCoreInfo] = useState<CoreInfo | null>(null);
  const [isCoreManagerOpen, setIsCoreManagerOpen] = useState(false);
  const [isModelSettingsOpen, setIsModelSettingsOpen] = useState(false);
  const [isSshModalOpen, setIsSshModalOpen] = useState(false);

  // 6. 右鍵選單 / 對話管理彈窗 / 提示
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [renameTarget, setRenameTarget] = useState<Session | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [expandAllCmd, setExpandAllCmd] = useState<{ action: 'expand' | 'collapse'; nonce: number } | null>(null);

  // 供只綁定一次的事件監聽讀取最新狀態
  const currentProjectRef = useRef(currentProject);
  currentProjectRef.current = currentProject;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  // 目前畫面上開著的對話
  const activeConvIdRef = useRef(activeConvId);
  activeConvIdRef.current = activeConvId;
  // convId ↔ session 檔名 對照（新對話要等 pi:ready 才知道未來檔名）
  const convFileByIdRef = useRef<Record<string, string>>({});
  const convIdByFileRef = useRef<Record<string, string>>({});

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2600);
  }, []);

  const pushSessionLog = useCallback((text: string) => {
    setSessionLogs(prev => [
      ...prev,
      { id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, ts: Date.now() },
    ]);
  }, []);

  // 依 convId 更新指定對話的訊息 / 指令 / 載入狀態
  const updateConvMessages = useCallback((convId: string, updater: (prev: Message[]) => Message[]) => {
    if (!convId) return;
    setMessagesByConv(prev => ({ ...prev, [convId]: updater(prev[convId] || []) }));
  }, []);
  const updateConvBash = useCallback((convId: string, updater: (prev: BashCommand[]) => BashCommand[]) => {
    if (!convId) return;
    setBashByConv(prev => ({ ...prev, [convId]: updater(prev[convId] || []) }));
  }, []);
  const setConvLoading = useCallback((convId: string, value: boolean) => {
    if (!convId) return;
    setLoadingByConv(prev => (prev[convId] === value ? prev : { ...prev, [convId]: value }));
  }, []);

  // 通知右側檔案瀏覽器重新整理當前目錄
  const loadWorkspaceFiles = async (_workspacePath?: string, _sshOverride?: SshConfig | null) => {
    setFileRefreshTrigger((n) => n + 1);
  };

  // 路徑正規化，用於合併「寫死的當前專案」與「磁碟讀到的真實專案」
  const normPath = (p?: string) => (p || '').toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
  const projectKey = (p: Project) => (p.ssh ? p.id : normPath(p.path));

  const loadRealProjects = async (): Promise<Project[]> => {
    if (!ipcRenderer) return [];
    try {
      const realProjects: Project[] = (await ipcRenderer.invoke('pi:get-real-projects')) || [];
      const map = new Map<string, Project>();
      // 磁碟與遠端為真實來源：直接以 rp.sessions 為準（可正確反映新增/刪除）
      realProjects.forEach(rp => map.set(projectKey(rp), rp));
      // 磁碟上已無任何會話的本機草稿工作區一併保留
      projectsRef.current.forEach(p => {
        if (p.ssh) return; // 遠端專案由 ssh-projects.json 決定存留
        const key = projectKey(p);
        if (!map.has(key)) map.set(key, { ...p, sessions: [] });
      });
      // 依最新對話時間排序，最新的專案排在最上面
      const merged = Array.from(map.values()).sort(
        (a, b) => (b.sessions[0]?.updatedAt || 0) - (a.sessions[0]?.updatedAt || 0)
      );
      setProjects(merged);
      return merged;
    } catch (e) {
      console.error('讀取歷史會話失敗:', e);
      return [];
    }
  };

  // 新對話送出第一則訊息後，Pi 才會落地 .jsonl；此時把它選取起來，並在回合結算時同步 .jsonl 內的真實 entryId 與分支資訊
  const settlePendingSession = useCallback(async (convId: string, syncHistory = false) => {
    if (!convId || !ipcRenderer) return;
    let file = convFileByIdRef.current[convId];
    const ssh = currentProjectRef.current.ssh;
    // 新對話：向子程序問出剛落地的 session 檔名
    if (!file) {
      try {
        const info = await ipcRenderer.invoke('pi:ensure-session', {
          convId,
          cwd: currentProjectRef.current.path,
          ssh,
          sessionFile: undefined,
        });
        file = info?.sessionFile || undefined;
        if (file) {
          convFileByIdRef.current[convId] = file;
          convIdByFileRef.current[file] = convId;
        }
      } catch (e) {
        /* 忽略 */
      }
    }
    if (!file) return;
    const list = await loadRealProjects();
    let matchedSessionId: string | undefined;
    for (const p of list) {
      const found = p.sessions.find(s => s.filePath === file);
      if (found) {
        matchedSessionId = found.id;
        break;
      }
    }
    if (matchedSessionId && activeConvIdRef.current === convId) {
      setActiveSessionId(matchedSessionId);
    }

    if (syncHistory) {
      try {
        const history: Message[] = await ipcRenderer.invoke(
          'pi:load-session',
          ssh ? { filePath: file, ssh } : file
        );
        if (Array.isArray(history) && history.length > 0) {
          updateConvMessages(convId, prev => {
            // 保留即時串流時掛在 assistant 訊息上的 subagents 紀錄
            const subagentsByIdx = new Map<number, SubagentTask[]>();
            let aiIdx = 0;
            for (const m of prev) {
              if (m.role === 'assistant') {
                if (m.subagents && m.subagents.length > 0) {
                  subagentsByIdx.set(aiIdx, m.subagents);
                }
                aiIdx++;
              }
            }
            let nextAiIdx = 0;
            return history.map(m => {
              if (m.role === 'assistant') {
                const subs = subagentsByIdx.get(nextAiIdx++);
                if (subs && (!m.subagents || m.subagents.length === 0)) {
                  return { ...m, subagents: subs };
                }
              }
              return m;
            });
          });
        }
      } catch (e) {
        /* 忽略 */
      }
    }
  }, [updateConvMessages]);

  // 監聽 Pi RPC 真實事件
  useEffect(() => {
    loadWorkspaceFiles();
    loadRealProjects();

    if (!ipcRenderer) {
      pushSessionLog('[Notice] 目前在純 Web 預覽模式。請使用「啟動Pi-UI桌面版.bat」開啟獨立桌面 App 即可完整串接本地真實 Pi RPC！');
      return;
    }

    // 取得初始核心資訊
    ipcRenderer.invoke('core:get-status').then((info: CoreInfo) => {
      if (info) setCoreInfo(info);
    });

    const handleCoreInfo = (_event: any, info: CoreInfo) => {
      setCoreInfo(info);
      pushSessionLog(`[Pi Core] 載入核心: [${info.type}] v${info.version} (${info.description})`);
    };
    ipcRenderer.on('core:info', handleCoreInfo);

    // Pi 就緒事件（每個對話都會回報自己的狀態）
    ipcRenderer.on('pi:ready', (_event: any, data: any) => {
      console.log('Pi Ready:', data);
      const convId = data.convId as string;
      const file = data.sessionFile as string | undefined;
      // 記住 convId ↔ 未來 session 檔名（新對話要送出第一則訊息才會落地）
      if (convId && file) {
        convFileByIdRef.current[convId] = file;
        convIdByFileRef.current[file] = convId;
      }
      const modelName = data.model?.name || data.model?.id || 'Connected Model';
      if (!convId || convId === activeConvIdRef.current) {
        setModelInfo(modelName);
        if (data.thinkingLevel) setThinkingLevel(data.thinkingLevel);
      }
      pushSessionLog(`[Pi Connected] ${file || 'active session'} | 模型: ${modelName} | Session: ${data.sessionId || 'active'}`);
      pushSessionLog(`[Workspace] ${data.workspace}`);
    });

    // 處理 Pi 串流事件（payload 帶 convId，分流到正確的對話）
    ipcRenderer.on('pi:event', (_event: any, payload: any) => {
      const convId: string = payload?.convId;
      const event: any = payload?.event;
      if (!convId || !event) return;
      console.log('Pi Event:', convId, event);

      // 1. 文字串流或思考串流 (message_update)
      if (event.type === 'message_update') {
        const assistantEvent = event.assistantMessageEvent;
        if (!assistantEvent) return;

        const kind = assistantEvent.type === 'text_delta'
          ? 'text'
          : assistantEvent.type === 'thinking_delta'
            ? 'thinking'
            : null;
        if (!kind) return;
        const delta: string = assistantEvent.delta || '';

        updateConvMessages(convId, prev => {
          const lastMsg = prev[prev.length - 1];
          if (!lastMsg || lastMsg.role !== 'assistant') {
            // 尚無助手訊息 → 建立一則，並把第一個片段依序放進 parts
            const base: Message = {
              id: `ai-${Date.now()}`,
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
              parts: [],
            };
            return [...prev, appendAssistantDelta(base, kind, delta)];
          }

          // 追加串流內容到目前最後一個同型別片段（保留交錯順序）
          return prev.map((msg, idx) =>
            idx === prev.length - 1 ? appendAssistantDelta(msg, kind, delta) : msg
          );
        });
      }

      // 2. 工具開始執行 (tool_execution_start)
      if (event.type === 'tool_execution_start') {
        const { toolName, args, toolCallId } = event;

        // 如果是 Subagent 工具呼叫
        if (toolName === 'subagent') {
          const subTask: SubagentTask = {
            id: toolCallId || `sub-${Date.now()}`,
            agent: args?.agent || 'worker',
            task: args?.task || JSON.stringify(args),
            status: 'running',
            tools: [],
            terminalLogs: [`\x1b[35m[Subagent:${args?.agent || 'worker'}]\x1b[0m 正在背景啟動獨立子代理...`],
          };

          updateConvMessages(convId, prev => {
            const lastMsg = prev[prev.length - 1];
            if (!lastMsg) return prev;
            return prev.map((msg, idx) =>
              idx === prev.length - 1 ? appendSubagentPart(msg, subTask) : msg
            );
          });
        }

        // 如果是 shell 工具（bash / powershell）→ 建立結構化指令卡片
        if (toolName === 'bash' || toolName === 'powershell') {
          const cmd = args?.command || '';
          updateConvBash(convId, prev => [
            ...prev,
            {
              id: toolCallId || `sh-${Date.now()}`,
              command: cmd,
              shell: toolName,
              output: '',
              status: 'running',
              startedAt: Date.now(),
            },
          ]);
        }

        // 記錄到一般 tools
        const newTool: ToolCall = {
          id: toolCallId || `tool-${Date.now()}`,
          name: toolName,
          args: args || {},
          status: 'running',
        };
        updateConvMessages(convId, prev => {
          const lastMsg = prev[prev.length - 1];
          if (!lastMsg) return prev;
          return prev.map((msg, idx) =>
            idx === prev.length - 1 ? appendToolPart(msg, newTool) : msg
          );
        });
      }

      // 3-a. tool_execution_update：partialResult 是最新「完整快照」→ 直接取代
      if (event.type === 'tool_execution_update') {
        const { toolCallId, partialResult } = event;
        const text = textFromResult(partialResult);
        if (toolCallId && text !== undefined) {
          updateConvBash(convId, prev =>
            prev.map(c =>
              c.id === toolCallId
                ? {
                    ...c,
                    output: text,
                    truncated: partialResult?.details?.truncation ? true : c.truncated,
                    fullOutputPath: partialResult?.details?.fullOutputPath || c.fullOutputPath,
                  }
                : c
            )
          );
          // 同步更新聊天區工具卡片的即時輸出
          updateConvMessages(convId, prev =>
            prev.map(msg =>
              msg.tools?.some(t => t.id === toolCallId)
                ? updateToolPart(msg, toolCallId, { output: text })
                : msg
            )
          );
        }
      }

      // 3-b. bash_execution_update：delta 是「增量」→ 附加（直接 RPC bash 才會用到）
      if (event.type === 'bash_execution_update') {
        const { id, delta } = event;
        if (id && delta) {
          updateConvBash(convId, prev =>
            prev.some(c => c.id === id)
              ? prev.map(c => (c.id === id ? { ...c, output: c.output + delta } : c))
              : [
                  ...prev,
                  { id, command: '(RPC bash)', shell: 'bash', output: delta, status: 'running', startedAt: Date.now() },
                ]
          );
        }
      }

      // 4. 工具結束 (tool_execution_end)
      if (event.type === 'tool_execution_end') {
        const { toolCallId, toolName, result, isError, durationMs } = event;

        // 收尾 shell 指令卡片（帶入最終輸出、exit code、耗時）
        if (toolName === 'bash' || toolName === 'powershell') {
          const finalText = textFromResult(result);
          const structured = result?.structuredContent;
          updateConvBash(convId, prev =>
            prev.map(c =>
              c.id === toolCallId
                ? {
                    ...c,
                    status: isError ? 'failed' : 'success',
                    output: finalText ?? c.output,
                    exitCode: structured?.exit_code ?? c.exitCode,
                    truncated: structured?.truncated ?? c.truncated,
                    fullOutputPath: structured?.full_output_path ?? c.fullOutputPath,
                    durationMs: durationMs ?? Date.now() - c.startedAt,
                    endedAt: Date.now(),
                  }
                : c
            )
          );
        }

        updateConvMessages(convId, prev => {
          return prev.map(msg => {
            // 一次更新所有符合的工具/子代理狀態（含 parts 內的有序片段）
            const foundTool = msg.tools?.some(t => t.id === toolCallId);
            const foundSub = msg.subagents?.some(s => s.id === toolCallId);
            if (!foundTool && !foundSub) return msg;
            let next = msg;
            const output = textFromResult(result) ?? JSON.stringify(result);
            if (foundTool)
              next = updateToolPart(next, toolCallId, {
                status: isError ? 'failed' : 'completed',
                output,
                // edit 工具會在 details.diff 附上差異內容，供對話區顯示 diff
                ...(typeof result?.details?.diff === 'string' ? { diff: result.details.diff } : {}),
              });
            if (foundSub) {
              next = updateSubagentPart(next, toolCallId, {
                status: 'completed',
                output: typeof result === 'string' ? result : JSON.stringify(result),
              });
            }
            return next;
          });
        });
        // 只有當前顯示的對話才需要重整檔案樹
        if (convId === activeConvIdRef.current) loadWorkspaceFiles();
      }

      // 5. 任務完成或結算 (agent_settled)
      if (event.type === 'agent_settled' || event.type === 'agent_end') {
        setConvLoading(convId, false);
        if (event.type === 'agent_settled') settlePendingSession(convId, true);
      }
    });

    return () => {
      ipcRenderer.removeAllListeners('pi:ready');
      ipcRenderer.removeAllListeners('pi:event');
    };
  }, []);

  // 告知主程序目前畫面上開著的對話（正在看的、閒置時保留；其餘跑完就回收）
  useEffect(() => {
    if (ipcRenderer && activeConvId) {
      ipcRenderer.send('pi:set-active', { convId: activeConvId });
    }
  }, [activeConvId]);

  // 首次載入：先為目前工作區準備一個新對話程序（閒置時可被回收）
  useEffect(() => {
    if (!ipcRenderer) return;
    const convId = `draft:${uuid()}`;
    activeConvIdRef.current = convId;
    setActiveConvId(convId);
    ipcRenderer.invoke('pi:ensure-session', { convId, cwd: currentProjectRef.current.path });
  }, []);

  // 發送訊息給真實的 Pi
  const handleSendMessage = useCallback((text: string) => {
    let convId = activeConvIdRef.current;
    // 尚未有作用中對話 → 在目前工作區建立一個新對話（draft）
    if (!convId) {
      convId = `draft:${uuid()}`;
      activeConvIdRef.current = convId;
      setActiveConvId(convId);
    }

    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    updateConvMessages(convId, prev => [...prev, userMsg]);
    setConvLoading(convId, true);

    if (ipcRenderer) {
      ipcRenderer.send('pi:send-prompt', {
        convId,
        message: text,
        cwd: currentProjectRef.current.path,
        ssh: currentProjectRef.current.ssh,
        sessionFile: convFileByIdRef.current[convId] || (convId.startsWith('draft:') ? undefined : convId),
      });
      // 新對話：第一則訊息會讓 session 檔落地，稍後回來選取它
      if (convId.startsWith('draft:')) {
        setTimeout(() => settlePendingSession(convId), 500);
        setTimeout(() => settlePendingSession(convId), 1500);
        setTimeout(() => settlePendingSession(convId), 3000);
      }
    } else {
      // 降級純前端提示
      setTimeout(() => {
        setConvLoading(convId, false);
        updateConvMessages(convId, prev => [
          ...prev,
          {
            id: `ai-${Date.now()}`,
            role: 'assistant',
            content: '已收到訊息！目前處於無 IPC 模式。若要體驗與本地 Pi Agent 的真實互動，請雙擊根目錄下的「啟動Pi-UI桌面版.bat」！',
            timestamp: Date.now(),
          }
        ]);
      }, 800);
    }
  }, [updateConvMessages, setConvLoading, settlePendingSession]);

  const handleStop = useCallback(() => {
    const convId = activeConvIdRef.current;
    if (ipcRenderer && convId) {
      ipcRenderer.send('pi:abort', { convId });
    }
    setConvLoading(convId, false);
  }, [setConvLoading]);

  const handleInspectSubagent = useCallback((task: SubagentTask) => {
    setSelectedSubagentId(task.id);
    setRightPanelTab('subagents');
  }, []);

  const handleOpenPathInRightPanel = useCallback((targetPath: string) => {
    if (!targetPath) return;
    setRightPanelTab('files');
    setRevealFileRequest({ path: targetPath, nonce: Date.now() + Math.random() });
  }, []);

  const handleSelectSession = async (session: Session, project?: Project) => {
    const filePath = session.filePath || session.id;
    const ssh = session.ssh || project?.ssh;
    // 沿用既有 convId（若此對話是本次執行新開的），否則以 session.id 當 convId
    const convId = convIdByFileRef.current[filePath] || session.id || filePath;
    activeConvIdRef.current = convId;
    setActiveConvId(convId);
    setActiveSessionId(session.id);
    // 記錄對應的 session 檔，之後送訊息時才能載入正確的會話
    if (session.filePath) {
      convFileByIdRef.current[convId] = session.filePath;
      convIdByFileRef.current[session.filePath] = convId;
    }
    if (project) {
      setCurrentProject(project);
      loadWorkspaceFiles(project.path, project.ssh || null);
    }

    // 已有記憶體中的訊息（例如背景正在串流）→ 直接顯示，不要蓋掉最新內容
    if ((messagesByConv[convId] || []).length > 0) return;

    // 純讀檔載入歷史（不切換任何子程序的核心會話）
    if (ipcRenderer && session.filePath) {
      try {
        const history: Message[] = await ipcRenderer.invoke(
          'pi:load-session',
          ssh ? { filePath: session.filePath, ssh } : session.filePath
        );
        updateConvMessages(convId, () =>
          Array.isArray(history) && history.length > 0
            ? history
            : [
                {
                  id: `empty-${Date.now()}`,
                  role: 'assistant' as const,
                  content: '（此會話沒有可顯示的訊息）',
                  timestamp: Date.now(),
                },
              ]
        );
      } catch (e) {
        console.error('載入歷史會話失敗:', e);
      }
    }
  };

  // 新對話唯一入口：左側專案列旁的「+」（必須有明確的工作區 cwd）
  const handleNewSession = (projectId?: string) => {
    const proj = projects.find(p => p.id === projectId);
    if (!proj) return;
    handleNewSessionInProject(proj);
  };

  // 開新對話：建立一個全新的 Pi 子程序（不會動到其他正在跑的對話）
  const handleNewSessionInProject = async (project: Project) => {
    const convId = `draft:${uuid()}`;
    activeConvIdRef.current = convId;
    setActiveConvId(convId);
    setCurrentProject(project);
    setActiveSessionId('');
    // 只清空這個新對話的狀態，其他背景對話不受影響
    setMessagesByConv(prev => ({ ...prev, [convId]: [] }));
    setBashByConv(prev => ({ ...prev, [convId]: [] }));
    setLoadingByConv(prev => ({ ...prev, [convId]: false }));
    if (ipcRenderer) {
      await ipcRenderer.invoke('pi:ensure-session', {
        convId,
        cwd: project.path,
        ssh: project.ssh,
      });
    }
    loadWorkspaceFiles(project.path, project.ssh || null);
    showToast(
      project.ssh
        ? `已在遠端「${project.ssh.host}:${project.name}」開新對話`
        : `已在「${project.name}」開新對話`
    );
  };

  const handleOpenFolder = async () => {
    if (!ipcRenderer) return;
    const selected = await ipcRenderer.invoke('dialog:openDirectory');
    if (!selected) return;
    const newProj: Project = {
      id: selected,
      name: selected.split(/[\\/]/).pop() || selected,
      path: selected,
      sessions: [],
    };
    setProjects(prev =>
      prev.some(p => !p.ssh && normPath(p.path) === normPath(selected)) ? prev : [newProj, ...prev]
    );
    await handleNewSessionInProject(newProj);
  };

  const handleSshProjectAdded = async (saved: { id: string; name: string; path: string; ssh: SshConfig }) => {
    const list = await loadRealProjects();
    const found = list.find(p => p.id === saved.id);
    const targetProj: Project = found || {
      id: saved.id,
      name: saved.name,
      path: saved.path,
      ssh: saved.ssh,
      sessions: [],
    };
    if (!found) {
      setProjects(prev => [targetProj, ...prev]);
    }
    await handleNewSessionInProject(targetProj);
  };

  const handleRemoveSshProject = async (project: Project) => {
    if (!ipcRenderer || !project.ssh) return;
    await ipcRenderer.invoke('ssh:remove-project', project.id);
    showToast(`已從列表移除遠端專案「${project.name}」`);
    await loadRealProjects();
  };

  // ---- 對話管理（跨 session） -------------------------------------------

  // 取檔案所在目錄（不依賴 node path）
  const dirOf = (p?: string) => (p || '').replace(/[\\/][^\\/]*$/, '');
  // 檔名安全處理
  const safeName = (s: string) =>
    (s || 'conversation').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'conversation';

  const handleRenameSession = (session: Session) => {
    setRenameValue(session.title || '');
    setRenameTarget(session);
  };

  const confirmRename = async () => {
    if (!renameTarget || !renameTarget.filePath || !ipcRenderer) {
      setRenameTarget(null);
      return;
    }
    const name = renameValue.trim();
    if (!name) return;
    const res = await ipcRenderer.invoke('pi:rename-session', {
      filePath: renameTarget.filePath,
      name,
      ssh: renameTarget.ssh,
    });
    if (res?.success) {
      showToast('已重新命名');
      await loadRealProjects();
    } else {
      showToast('重新命名失敗：' + (res?.error || '未知錯誤'));
    }
    setRenameTarget(null);
  };

  const handleDuplicateSession = async (session: Session) => {
    if (!session.filePath || !ipcRenderer) return;
    const res = await ipcRenderer.invoke(
      'pi:duplicate-session',
      session.ssh ? { filePath: session.filePath, ssh: session.ssh } : session.filePath
    );
    if (res?.success) {
      showToast('已複製整個對話');
      await loadRealProjects();
    } else {
      showToast('複製失敗：' + (res?.error || '未知錯誤'));
    }
  };

  const handleExportSession = async (session: Session, format: 'html' | 'jsonl') => {
    if (!session.filePath || !ipcRenderer) return;
    const ext = format === 'html' ? 'html' : 'jsonl';
    const defaultPath = session.ssh
      ? `${safeName(session.title)}.${ext}`
      : `${dirOf(session.filePath)}\\${safeName(session.title)}.${ext}`;
    const filters =
      format === 'html'
        ? [{ name: 'HTML 網頁', extensions: ['html'] }]
        : [{ name: 'JSONL 會話檔', extensions: ['jsonl'] }];
    const outputPath = await ipcRenderer.invoke('dialog:save-file', { defaultPath, filters });
    if (!outputPath) return;
    const res = await ipcRenderer.invoke('pi:export-session', {
      filePath: session.filePath,
      format,
      outputPath,
      ssh: session.ssh,
    });
    if (res?.success) showToast('已匯出：' + res.path);
    else showToast('匯出失敗：' + (res?.error || '未知錯誤'));
  };

  const handleCopyPath = async (text: string) => {
    if (ipcRenderer) await ipcRenderer.invoke('clipboard:write', text);
    showToast('已複製路徑');
  };

  const handleDeleteSession = (session: Session) => setDeleteTarget(session);

  const confirmDelete = async () => {
    if (!deleteTarget || !deleteTarget.filePath || !ipcRenderer) {
      setDeleteTarget(null);
      return;
    }
    const res = await ipcRenderer.invoke(
      'pi:delete-session',
      deleteTarget.ssh ? { filePath: deleteTarget.filePath, ssh: deleteTarget.ssh } : deleteTarget.filePath
    );
    if (res?.success) {
      showToast(res.trashed ? '已移至資源回收筒' : '已刪除對話');
      if (activeSessionId === deleteTarget.id) {
        setActiveSessionId('');
        const convId = activeConvIdRef.current;
        if (convId) setMessagesByConv(prev => ({ ...prev, [convId]: [] }));
      }
      await loadRealProjects();
    } else {
      showToast('刪除失敗：' + (res?.error || '未知錯誤'));
    }
    setDeleteTarget(null);
  };

  const expandAll = (action: 'expand' | 'collapse') => setExpandAllCmd({ action, nonce: Date.now() });

  // ---- 單一使用者訊息粒度操作（對話框角落按鈕） --------------------------

  const resolveActiveSessionTarget = useCallback(async () => {
    const convId = activeConvIdRef.current;
    if (!convId) return null;
    const ssh = currentProjectRef.current.ssh;
    let filePath = convFileByIdRef.current[convId];
    if (!filePath && !convId.startsWith('draft:')) {
      filePath = convId;
    }
    if (!filePath && ipcRenderer) {
      try {
        const info = await ipcRenderer.invoke('pi:ensure-session', {
          convId,
          cwd: currentProjectRef.current.path,
          ssh,
        });
        if (info?.sessionFile) {
          filePath = info.sessionFile;
          convFileByIdRef.current[convId] = filePath;
          convIdByFileRef.current[filePath] = convId;
        }
      } catch {
        /* 忽略 */
      }
    }
    if (!filePath) return null;
    return { convId, filePath, ssh };
  }, []);

  const handleCopyMessage = useCallback(async (text: string) => {
    if (ipcRenderer) {
      await ipcRenderer.invoke('clipboard:write', text);
    } else {
      navigator.clipboard?.writeText(text).catch(() => {});
    }
    showToast('已複製訊息內容');
  }, []);

  const handleSwitchBranch = useCallback(async (_message: Message, targetLeafId: string) => {
    if (!ipcRenderer) return;
    const target = await resolveActiveSessionTarget();
    if (!target) return;
    const res = await ipcRenderer.invoke('pi:switch-branch', {
      filePath: target.filePath,
      targetLeafId,
      ssh: target.ssh,
      convId: target.convId,
    });
    if (res?.success && Array.isArray(res.messages)) {
      updateConvMessages(target.convId, () => res.messages);
      showToast('已切換平行對話分支');
    } else {
      showToast('切換分支失敗：' + (res?.error || '未知錯誤'));
    }
  }, [resolveActiveSessionTarget, updateConvMessages]);

  const handleEditAndResend = useCallback(async (message: Message, newText: string, userTurnIndex: number) => {
    if (!ipcRenderer) return;
    const target = await resolveActiveSessionTarget();
    if (!target) return;
    const res = await ipcRenderer.invoke('pi:rewind-before-entry', {
      filePath: target.filePath,
      entryId: message.id,
      userTurnIndex,
      messageText: message.content,
      ssh: target.ssh,
      convId: target.convId,
    });
    if (!res?.success) {
      showToast('建立編輯分支失敗：' + (res?.error || '未知錯誤'));
      return;
    }
    if (Array.isArray(res.messages)) {
      updateConvMessages(target.convId, () => res.messages);
    }
    handleSendMessage(newText);
  }, [resolveActiveSessionTarget, updateConvMessages, handleSendMessage]);

  const handleRegenerate = useCallback(async (message: Message, userTurnIndex: number) => {
    if (!ipcRenderer) return;
    const target = await resolveActiveSessionTarget();
    if (!target) return;
    const res = await ipcRenderer.invoke('pi:rewind-before-entry', {
      filePath: target.filePath,
      entryId: message.id,
      userTurnIndex,
      messageText: message.content,
      ssh: target.ssh,
      convId: target.convId,
    });
    if (!res?.success) {
      showToast('重新生成失敗：' + (res?.error || '未知錯誤'));
      return;
    }
    if (Array.isArray(res.messages)) {
      updateConvMessages(target.convId, () => res.messages);
    }
    handleSendMessage(message.content);
  }, [resolveActiveSessionTarget, updateConvMessages, handleSendMessage]);

  const handleForkFromMessage = useCallback(async (message: Message, userTurnIndex: number) => {
    if (!ipcRenderer) return;
    const target = await resolveActiveSessionTarget();
    if (!target) return;
    const res = await ipcRenderer.invoke('pi:fork-session', {
      filePath: target.filePath,
      entryId: message.id,
      userTurnIndex,
      messageText: message.content,
      ssh: target.ssh,
    });
    if (!res?.success || !res.newPath) {
      showToast('分叉對話失敗：' + (res?.error || '未知錯誤'));
      return;
    }
    const list = await loadRealProjects();
    let forkedSession: Session | undefined;
    let forkedProject: Project | undefined;
    for (const p of list) {
      const found = p.sessions.find(s => s.filePath === res.newPath);
      if (found) {
        forkedSession = found;
        forkedProject = p;
        break;
      }
    }
    if (forkedSession) {
      await handleSelectSession(forkedSession, forkedProject);
    }
    showToast('已從該處分叉出獨立的新對話');
  }, [resolveActiveSessionTarget]);

  const handleSetMessageLabel = useCallback(async (message: Message, label: string | undefined, userTurnIndex: number) => {
    if (!ipcRenderer) return;
    const target = await resolveActiveSessionTarget();
    if (!target) return;
    const res = await ipcRenderer.invoke('pi:set-entry-label', {
      filePath: target.filePath,
      entryId: message.id,
      userTurnIndex,
      messageText: message.content,
      label,
      ssh: target.ssh,
      convId: target.convId,
    });
    if (res?.success && Array.isArray(res.messages)) {
      updateConvMessages(target.convId, () => res.messages);
      showToast(label ? `已標記書籤：${label}` : '已移除書籤');
    } else {
      showToast('設定書籤失敗：' + (res?.error || '未知錯誤'));
    }
  }, [resolveActiveSessionTarget, updateConvMessages]);

  const handleToggleMessageOmit = useCallback(async (message: Message, userTurnIndex: number) => {
    if (!ipcRenderer) return;
    const target = await resolveActiveSessionTarget();
    if (!target) return;
    const res = await ipcRenderer.invoke('pi:toggle-context-omit', {
      filePath: target.filePath,
      entryId: message.id,
      userTurnIndex,
      messageText: message.content,
      ssh: target.ssh,
      convId: target.convId,
    });
    if (res?.success && Array.isArray(res.messages)) {
      updateConvMessages(target.convId, () => res.messages);
      showToast(res.omitted ? '已將此輪對話從 AI 上下文隱藏' : '已恢復此輪對話至 AI 上下文');
    } else {
      showToast('切換上下文狀態失敗：' + (res?.error || '未知錯誤'));
    }
  }, [resolveActiveSessionTarget, updateConvMessages]);

  // ---- 右鍵選單內容 --------------------------------------------------

  const openSessionMenu = (session: Session, project: Project, x: number, y: number) => {
    const sWithSsh: Session = session.ssh ? session : { ...session, ssh: project.ssh };
    const items: ContextMenuItem[] = [
      { label: '開啟', icon: <Play size={14} />, onClick: () => handleSelectSession(sWithSsh, project) },
      { separator: true },
      { label: '重新命名…', icon: <Pencil size={14} />, onClick: () => handleRenameSession(sWithSsh) },
      { label: '複製整個對話', icon: <CopyPlus size={14} />, onClick: () => handleDuplicateSession(sWithSsh) },
      {
        label: '匯出',
        icon: <Download size={14} />,
        submenu: [
          { label: '匯出 HTML…', icon: <FileCode size={14} />, onClick: () => handleExportSession(sWithSsh, 'html') },
          { label: '匯出 JSONL…', icon: <FileJson size={14} />, onClick: () => handleExportSession(sWithSsh, 'jsonl') },
        ],
      },
      { label: '複製路徑', icon: <ClipboardIcon size={14} />, onClick: () => handleCopyPath(sWithSsh.filePath || sWithSsh.id) },
      { separator: true },
      { label: '刪除', icon: <Trash2 size={14} />, danger: true, onClick: () => handleDeleteSession(sWithSsh) },
    ];
    setContextMenu({ x, y, items });
  };

  const openProjectMenu = (project: Project, x: number, y: number) => {
    const items: ContextMenuItem[] = [
      { label: '新對話', icon: <Plus size={14} />, onClick: () => handleNewSessionInProject(project) },
      ...(project.ssh
        ? [
            {
              label: `複製 SSH 路徑 (${project.ssh.host}:${project.path})`,
              icon: <ClipboardIcon size={14} />,
              onClick: () => handleCopyPath(`${project.ssh!.host}:${project.path}`),
            },
          ]
        : [
            {
              label: '在檔案總管中開啟',
              icon: <FolderOpen size={14} />,
              onClick: () => ipcRenderer?.invoke('shell:open-path', project.path),
            },
            {
              label: '複製路徑',
              icon: <ClipboardIcon size={14} />,
              onClick: () => handleCopyPath(project.path),
            },
          ]),
      { separator: true },
      { label: '重新整理', icon: <RefreshCw size={14} />, onClick: () => { loadRealProjects(); showToast('已重新整理'); } },
      ...(project.ssh
        ? [
            { separator: true },
            {
              label: '從列表移除此遠端專案',
              icon: <Trash2 size={14} />,
              danger: true,
              onClick: () => handleRemoveSshProject(project),
            },
          ]
        : []),
    ];
    setContextMenu({ x, y, items });
  };

  const openBlankMenu = (x: number, y: number) => {
    const items: ContextMenuItem[] = [
      { label: '新增本機工作區…', icon: <FolderPlus size={14} />, onClick: handleOpenFolder },
      { label: '新增 SSH 遠端專案…', icon: <Server size={14} />, onClick: () => setIsSshModalOpen(true) },
      { separator: true },
      { label: '全部展開', icon: <ChevronsUpDown size={14} />, onClick: () => expandAll('expand') },
      { label: '全部收合', icon: <ChevronsUpDown size={14} />, onClick: () => expandAll('collapse') },
    ];
    setContextMenu({ x, y, items });
  };

  const allSubagents = messages.flatMap(m => m.subagents || []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#121214]">
      {/* 1. 左側欄：Projects / Sessions 樹狀清單 */}
      <Sidebar
        projects={projects}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        onOpenFolder={handleOpenFolder}
        onOpenSshModal={() => setIsSshModalOpen(true)}
        coreInfo={coreInfo}
        onOpenCoreManager={() => setIsCoreManagerOpen(true)}
        onOpenModelSettings={() => setIsModelSettingsOpen(true)}
        onSessionContextMenu={openSessionMenu}
        onProjectContextMenu={openProjectMenu}
        onBlankContextMenu={openBlankMenu}
        expandAllCommand={expandAllCmd}
        width={sidebarWidth}
      />

      {/* 可拖曳分隔線：左側欄 ↔ 中間對話區 */}
      <ResizeHandle
        ariaLabel="調整左側欄寬度"
        onResize={handleSidebarResize}
        onResizeEnd={() => persistPanelWidths(sidebarWidth, rightPanelWidth)}
        onReset={() => setSidebarWidth(SIDEBAR_DEFAULT)}
      />

      {/* 2. 中間欄：主對話區 (對接真實 Pi 串流與 Subagent 卡片) */}
      <ChatArea
        messages={messages}
        isLoading={isLoading}
        onSendMessage={handleSendMessage}
        onStop={handleStop}
        onInspectSubagent={handleInspectSubagent}
        projectName={currentProject.ssh ? `${currentProject.name} (${currentProject.ssh.host})` : currentProject.name}
        projectPath={currentProject.ssh ? `${currentProject.ssh.host}:${currentProject.path}` : currentProject.path}
        conversationId={activeConvId}
        modelInfo={modelInfo}
        thinkingLevel={thinkingLevel}
        onOpenModelSettings={() => setIsModelSettingsOpen(true)}
        onCopyMessage={handleCopyMessage}
        onSwitchBranch={handleSwitchBranch}
        onEditAndResend={handleEditAndResend}
        onRegenerate={handleRegenerate}
        onForkFromMessage={handleForkFromMessage}
        onSetMessageLabel={handleSetMessageLabel}
        onToggleMessageOmit={handleToggleMessageOmit}
        onOpenPath={handleOpenPathInRightPanel}
      />

      {/* 可拖曳分隔線：中間對話區 ↔ 右側欄 */}
      <ResizeHandle
        ariaLabel="調整右側欄寬度"
        onResize={handleRightPanelResize}
        onResizeEnd={() => persistPanelWidths(sidebarWidth, rightPanelWidth)}
        onReset={() => setRightPanelWidth(RIGHT_PANEL_DEFAULT)}
      />

      {/* 3. 右側欄：工作區工具箱 (Files / xterm Terminal / Subagents) */}
      <RightPanel
        activeTab={rightPanelTab}
        onTabChange={setRightPanelTab}
        files={files}
        currentWorkspace={currentProject.path}
        ssh={currentProject.ssh}
        subagents={allSubagents}
        selectedSubagentId={selectedSubagentId}
        onSelectSubagent={id => setSelectedSubagentId(id)}
        refreshTrigger={fileRefreshTrigger}
        onRefreshFiles={() => loadWorkspaceFiles()}
        revealRequest={revealFileRequest}
        width={rightPanelWidth}
      />

      {/* 4. 核心管理與更新 Modal */}
      <CoreManagerModal
        isOpen={isCoreManagerOpen}
        onClose={() => setIsCoreManagerOpen(false)}
        coreInfo={coreInfo}
        onCoreReload={() => {
          if (ipcRenderer) {
            ipcRenderer.invoke('core:get-status').then((info: CoreInfo) => {
              if (info) setCoreInfo(info);
            });
          }
        }}
      />

      {/* 4b. 模型與細項參數設定 Modal */}
      <ModelSettingsModal
        isOpen={isModelSettingsOpen}
        onClose={() => setIsModelSettingsOpen(false)}
        activeConvId={activeConvId}
        onModelChanged={(name, level) => {
          setModelInfo(name);
          if (level) setThinkingLevel(level);
        }}
      />

      {/* 4c. SSH 遠端專案連線與目錄選擇器 Modal */}
      <SshModal
        isOpen={isSshModalOpen}
        onClose={() => setIsSshModalOpen(false)}
        onProjectAdded={handleSshProjectAdded}
      />

      {/* 5. 自製右鍵選單 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* 6. 重新命名彈窗 */}
      {renameTarget && (
        <div
          className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60"
          onMouseDown={() => setRenameTarget(null)}
        >
          <div
            className="w-[420px] rounded-xl border border-[#3f3f46] bg-[#1f1f23] p-5 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-zinc-100 mb-3 flex items-center gap-2">
              <Pencil size={15} /> 重新命名對話
            </h3>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmRename();
                if (e.key === 'Escape') setRenameTarget(null);
              }}
              className="w-full rounded-md bg-[#121214] border border-[#3f3f46] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              placeholder="輸入對話名稱"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setRenameTarget(null)}
                className="px-3 py-1.5 rounded-md text-sm text-zinc-300 hover:bg-zinc-800 transition"
              >
                取消
              </button>
              <button
                onClick={confirmRename}
                className="px-3 py-1.5 rounded-md text-sm bg-blue-600 hover:bg-blue-500 text-white transition"
              >
                儲存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7. 刪除確認彈窗 */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60"
          onMouseDown={() => setDeleteTarget(null)}
        >
          <div
            className="w-[420px] rounded-xl border border-[#3f3f46] bg-[#1f1f23] p-5 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-red-400 mb-2 flex items-center gap-2">
              <AlertTriangle size={15} /> 刪除對話
            </h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              確定要刪除「<span className="text-zinc-200">{deleteTarget.title}</span>」嗎？
              <br />
              檔案會先移到資源回收筒，你可以從回收筒還原。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-3 py-1.5 rounded-md text-sm text-zinc-300 hover:bg-zinc-800 transition"
              >
                取消
              </button>
              <button
                onClick={confirmDelete}
                className="px-3 py-1.5 rounded-md text-sm bg-red-600 hover:bg-red-500 text-white transition"
              >
                刪除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 8. 輕量提示 toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[1200] rounded-lg border border-[#3f3f46] bg-[#1f1f23] px-4 py-2 text-sm text-zinc-100 shadow-2xl max-w-[70vw] truncate">
          {toast}
        </div>
      )}
    </div>
  );
};
