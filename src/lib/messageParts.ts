import type { Message, MessagePart, ToolCall, SubagentTask } from '../types';

/**
 * 取得訊息的有序片段。
 * 新資料直接使用 msg.parts；舊資料（僅有 content/thinking/tools/subagents）
 * 則攤平成一個近似順序的片段陣列，確保渲染邏輯一致。
 */
export const getMessageParts = (msg: Message): MessagePart[] => {
  if (msg.parts && msg.parts.length > 0) return msg.parts;
  const parts: MessagePart[] = [];
  if (msg.thinking) parts.push({ type: 'thinking', text: msg.thinking });
  if (msg.content) parts.push({ type: 'text', text: msg.content });
  (msg.tools || []).forEach((tool) => parts.push({ type: 'tool', tool }));
  (msg.subagents || []).forEach((task) => parts.push({ type: 'subagent', task }));
  return parts;
};

/**
 * 在助手訊息串流中追加文字/思考 delta。
 * 若最後一個片段是相同型別，就接續在後；否則新增一個片段，
 * 藉此保留「思考 → 文字 → 工具 → 思考 → 文字」的真實交錯順序。
 * 同時同步舊欄位 content / thinking，讓其他面板與舊資料相容。
 */
export const appendAssistantDelta = (
  msg: Message,
  kind: 'text' | 'thinking',
  delta: string
): Message => {
  const parts: MessagePart[] = msg.parts ? [...msg.parts] : [];
  const last = parts[parts.length - 1];
  if (last && last.type === kind) {
    parts[parts.length - 1] = { type: kind, text: last.text + delta } as MessagePart;
  } else {
    parts.push({ type: kind, text: delta } as MessagePart);
  }
  return {
    ...msg,
    parts,
    content: kind === 'text' ? msg.content + delta : msg.content,
    thinking: kind === 'thinking' ? (msg.thinking || '') + delta : msg.thinking,
  };
};

/** 追加一個工具呼叫片段（同步舊 tools 欄位）。 */
export const appendToolPart = (msg: Message, tool: ToolCall): Message => ({
  ...msg,
  parts: [...(msg.parts || []), { type: 'tool', tool }],
  tools: [...(msg.tools || []), tool],
});

/** 追加一個子代理片段（同步舊 subagents 欄位）。 */
export const appendSubagentPart = (msg: Message, task: SubagentTask): Message => ({
  ...msg,
  parts: [...(msg.parts || []), { type: 'subagent', task }],
  subagents: [...(msg.subagents || []), task],
});

/** 更新某個工具呼叫的狀態／輸出（同時更新 parts 與舊 tools 欄位）。 */
export const updateToolPart = (
  msg: Message,
  toolId: string,
  patch: Partial<ToolCall>
): Message => ({
  ...msg,
  tools: msg.tools?.map((t) => (t.id === toolId ? { ...t, ...patch } : t)),
  parts: msg.parts?.map((p) =>
    p.type === 'tool' && p.tool.id === toolId ? { type: 'tool', tool: { ...p.tool, ...patch } } : p
  ),
});

/** 更新某個子代理的狀態／輸出（同時更新 parts 與舊 subagents 欄位）。 */
export const updateSubagentPart = (
  msg: Message,
  taskId: string,
  patch: Partial<SubagentTask>
): Message => ({
  ...msg,
  subagents: msg.subagents?.map((s) => (s.id === taskId ? { ...s, ...patch } : s)),
  parts: msg.parts?.map((p) =>
    p.type === 'subagent' && p.task.id === taskId
      ? { type: 'subagent', task: { ...p.task, ...patch } }
      : p
  ),
});
