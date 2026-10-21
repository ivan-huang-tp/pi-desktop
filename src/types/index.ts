export interface SshConfig {
  id: string;        // 唯一識別，例如 "user@192.168.1.50:22"
  host: string;      // "user@host" 或 ~/.ssh/config 別名
  port?: number;     // 預設 22
  password?: string; // 選填；留空走 SSH Key，有填走 SSH_ASKPASS
  label?: string;    // 選填顯示別名
}

export interface RemoteDirEntry {
  name: string;
  path: string;
}

export interface DiscoveredRemoteProject {
  path: string;
  name: string;
  sessionCount: number;
  updatedAt: number;
}

export interface RemoteBrowseResult {
  success: boolean;
  error?: string;
  currentPath?: string;
  parentPath?: string | null;
  homeDir?: string;
  directories?: RemoteDirEntry[];
  discoveredProjects?: DiscoveredRemoteProject[];
  piAvailable?: boolean;
  piPath?: string | null;
  nodeVersion?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  sessions: Session[];
  isExpanded?: boolean;
  ssh?: SshConfig;
}

export interface Session {
  id: string;
  projectId: string;
  title: string;
  timeAgo: string;
  updatedAt: number;
  filePath?: string;
  ssh?: SshConfig;
}

export type Role = 'user' | 'assistant' | 'system';

export interface ToolCall {
  id: string;
  name: string; // 'bash' | 'read' | 'write' | 'subagent' | etc.
  args: Record<string, any>;
  status: 'running' | 'completed' | 'failed';
  output?: string;
  // edit 工具完成後 Pi 回傳的 diff（result.details.diff，格式為 "+12 line" / "-12 line" / " 12 line"）
  diff?: string;
  startTime?: number;
  endTime?: number;
}

export interface SubagentTask {
  id: string;
  agent: string; // e.g., 'scout' | 'planner' | 'reviewer' | 'worker'
  task: string;
  status: 'running' | 'completed' | 'failed';
  thinking?: string;
  tools: ToolCall[];
  output?: string;
  tokensUsed?: number;
  terminalLogs?: string[];
}

// Pi 的 shell 指令執行紀錄（右側面板用結構化卡片顯示）
export interface BashCommand {
  id: string; // 對應 Pi 的 toolCallId
  command: string;
  shell: 'bash' | 'powershell' | string;
  output: string; // 最新一份完整輸出快照
  status: 'running' | 'success' | 'failed';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  exitCode?: number;
  truncated?: boolean;
  fullOutputPath?: string;
}

// 非指令類的工作階段訊息（連線、核心載入等）
export interface SessionLog {
  id: string;
  text: string;
  ts: number;
}

// 助手回覆中的單一有序片段：思考、文字、工具呼叫、子代理會依實際發生順序排列
// （保留既有 content/thinking/tools/subagents 欄位以相容其他面板與舊資料）
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; tool: ToolCall }
  | { type: 'subagent'; task: SubagentTask };

export interface Message {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  thinking?: string;
  tools?: ToolCall[];
  subagents?: SubagentTask[];
  // 依時間順序排列的內容片段（新資料來源；渲染時優先使用）
  parts?: MessagePart[];
  // Session Tree 分支與單一訊息操作中繼資料
  parentId?: string | null;
  branchIndex?: number;       // 1-based，目前位於第幾個同層分支
  branchCount?: number;       // 同層分支總數（> 1 時顯示分支切換器）
  siblingLeafIds?: string[];  // 每個同層分支對應的最新 leaf entryId
  label?: string;             // 書籤標籤 (LabelEntry)
  omitted?: boolean;          // 是否已透過 ContextEditEntry 從 AI 上下文略過
}

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileItem[];
  size?: number;
  mtimeMs?: number;
  isHidden?: boolean;
}

export interface DirectoryReadResult {
  success: boolean;
  error?: string;
  currentPath: string;
  parentPath: string | null;
  items: FileItem[];
}

export interface FileReadResult {
  success: boolean;
  error?: string;
  filePath: string;
  name: string;
  kind: 'text' | 'image' | 'binary';
  content?: string;
  dataUrl?: string;
  size: number;
  truncated?: boolean;
}

export interface CoreInfo {
  type: 'bundled' | 'user' | 'system';
  version: string;
  cliPath?: string | null;
  baseDir?: string | null;
  description: string;
}

export interface CheckUpdateResult {
  success: boolean;
  currentType?: 'bundled' | 'user' | 'system';
  currentVersion?: string;
  latestVersion?: string;
  hasUpdate?: boolean;
  error?: string;
  description?: string;
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelDetailConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  samplingParams?: {
    temperature?: number;
    top_p?: number;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface ProviderDetailConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: ModelDetailConfig[];
  [key: string]: any;
}

export interface ModelsConfig {
  $schema?: string;
  providers: Record<string, ProviderDetailConfig>;
}

export interface SettingsConfig {
  $schema?: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  lastChangelogVersion?: string;
  [key: string]: any;
}

