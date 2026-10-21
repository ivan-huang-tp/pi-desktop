const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomBytes, randomUUID } = require('crypto');
const { CoreManager } = require('./core-manager.cjs');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// 從 message content (字串或區塊陣列) 取出純文字
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

// 相對時間顯示
function timeAgo(ms) {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ms).toLocaleDateString();
}

/* ==========================================================================
 * PiProcess：單一對話 = 單一 Pi RPC 子程序
 *
 * 每個對話擁有自己的子程序，因此「切換畫面上的對話」不會再對任何程序送出
 * switch_session / new_session，也就不會觸發 Pi 內部的 teardownCurrent() →
 * session.abort()，正在背景執行的 agent 得以繼續。
 * ========================================================================== */
class PiProcess {
  constructor(bridge, convId, workspace, opts = {}) {
    this.bridge = bridge;
    this.convId = convId;
    this.workspace = workspace || process.cwd();
    this.requestedSessionFile = opts.sessionFile || null; // 要載入的既有對話（可為 null = 全新）
    this.process = null;
    this.buffer = '';
    this.pending = new Map(); // id -> { resolve, timer }
    this.model = null;
    this.thinkingLevel = 'medium';
    this.sessionFile = null;
    this.sessionId = null;
    this.isStreaming = false;
    this.disposed = false;
    this.ready = null;
  }

  start() {
    const core = this.bridge.activeCoreInfo || this.bridge.coreManager.resolveCore();
    const env = { ...process.env };

    // windowsHide 讓 Windows 不為子程序彈出 console 視窗；
    // stderr 改用 pipe（不用 inherit）避免沿用父程序 console handle。
    const spawnOpts = {
      cwd: this.workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    };

    if (core.cliPath) {
      this.process = spawn('node', [core.cliPath, '--mode', 'rpc'], spawnOpts);
    } else {
      this.process = spawn('cmd.exe', ['/c', 'pi', '--mode', 'rpc'], spawnOpts);
    }

    this.process.stdout.on('data', (chunk) => this.onData(chunk));
    if (this.process.stderr) {
      this.process.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) console.error(`[PiProcess:${this.convId}] ${text}`);
      });
    }

    this.process.on('error', (err) => {
      console.error(`[PiProcess:${this.convId}] 進程啟動錯誤:`, err);
      this.bridge.sendToRenderer('pi:status', { convId: this.convId, running: false, error: err.message });
      this._rejectAll(err.message);
    });

    this.process.on('close', (code) => {
      const intentional = this.disposed;
      console.log(`[PiProcess:${this.convId}] 已退出，Exit Code: ${code}`);
      this.bridge.sendToRenderer('pi:status', { convId: this.convId, running: false, code });
      this.disposed = true;
      this._rejectAll('process closed');
      // 非預期結束才需要讓前端脫離「載入中」
      if (!intentional) {
        this.isStreaming = false;
        this.bridge.onSettled(this.convId);
      }
    });

    // 初始化：載入指定對話（閒置時 switch 是安全的）→ 取回狀態
    this.ready = (async () => {
      await delay(300);
      if (this.disposed) return;
      if (this.requestedSessionFile) {
        const res = await this.sendCommandAwait(
          { type: 'switch_session', sessionPath: this.requestedSessionFile },
          15000
        );
        if (!res || res.success === false) {
          console.error(`[PiProcess:${this.convId}] switch_session 失敗:`, res && res.error);
        }
      }
      await this.refreshState();
    })();

    return this.ready;
  }

  _rejectAll(reason) {
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve({ success: false, error: reason });
    }
    this.pending.clear();
  }

  onData(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch (err) {
        console.error('[PiBridge] 無法解析 JSON:', trimmed);
        continue;
      }
      this.handleEvent(event);
    }
  }

  sendCommand(cmd) {
    if (!this.process || !this.process.stdin || !this.process.stdin.writable) return false;
    this.process.stdin.write(JSON.stringify(cmd) + '\n');
    return true;
  }

  sendCommandAwait(cmd, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const id = cmd.id || `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      cmd.id = id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ success: false, error: 'timeout' });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      if (!this.sendCommand(cmd)) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ success: false, error: 'process not ready' });
      }
    });
  }

  handleEvent(event) {
    // 對應等待中的指令回應
    if (event.type === 'response' && event.id && this.pending.has(event.id)) {
      const { resolve, timer } = this.pending.get(event.id);
      clearTimeout(timer);
      this.pending.delete(event.id);
      resolve(event);
    }

    // 更新狀態
    if (event.type === 'response' && event.command === 'get_state' && event.data) {
      this.applyState(event.data);
    }

    // prompt 沒有實際啟動回合（被 handled）或失敗時，不能一直卡在忙碌
    if (
      event.type === 'response' &&
      event.command === 'prompt' &&
      (event.success === false || (event.data && event.data.disposition === 'handled'))
    ) {
      this.isStreaming = false;
      this.bridge.onSettled(this.convId);
    }

    // 追蹤是否正在執行（有活動就不回收）
    if (
      event.type === 'message_update' ||
      event.type === 'tool_execution_start' ||
      event.type === 'tool_execution_update' ||
      event.type === 'tool_execution_end'
    ) {
      this.isStreaming = true;
      this.bridge.notifyBusy(this.convId);
    }

    if (event.type === 'agent_end') {
      // 低階 run 結束，但可能還有 retry / compaction / steering，先不急著標閒置
      this.bridge.notifyBusy(this.convId);
    }

    if (event.type === 'agent_settled') {
      this.isStreaming = false;
      this.bridge.onSettled(this.convId);
    }

    // 轉發給前端（帶上 convId 以便分流到正確的對話）
    this.bridge.sendToRenderer('pi:event', { convId: this.convId, event });
  }

  applyState(data) {
    if (data.model) this.model = data.model;
    if (data.sessionFile) this.sessionFile = data.sessionFile;
    if (data.sessionId) this.sessionId = data.sessionId;
    if (data.thinkingLevel) this.thinkingLevel = data.thinkingLevel;
    if (typeof data.isStreaming === 'boolean' && !data.isStreaming) {
      // 注意：get_state 的 isStreaming 只反映當下，不動態覆寫忙碌中的判斷
    }
    this.bridge.sendToRenderer('pi:ready', {
      convId: this.convId,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      workspace: this.workspace,
      core: this.bridge.activeCoreInfo,
    });
  }

  async setModel(provider, modelId) {
    const res = await this.sendCommandAwait({
      type: 'set_model',
      provider,
      modelId,
    }, 10000);
    if (res && res.success && res.data) {
      this.model = res.data;
      this.bridge.sendToRenderer('pi:ready', {
        convId: this.convId,
        model: this.model,
        thinkingLevel: this.thinkingLevel,
        sessionId: this.sessionId,
        sessionFile: this.sessionFile,
        workspace: this.workspace,
        core: this.bridge.activeCoreInfo,
      });
    }
    return res;
  }

  async setThinkingLevel(level) {
    const res = await this.sendCommandAwait({
      type: 'set_thinking_level',
      level,
    }, 10000);
    if (res && res.success) {
      this.thinkingLevel = level;
      this.bridge.sendToRenderer('pi:ready', {
        convId: this.convId,
        model: this.model,
        thinkingLevel: this.thinkingLevel,
        sessionId: this.sessionId,
        sessionFile: this.sessionFile,
        workspace: this.workspace,
        core: this.bridge.activeCoreInfo,
      });
    }
    return res;
  }

  refreshState() {
    return this.sendCommandAwait({ type: 'get_state' }, 10000);
  }

  async prompt(message, id) {
    this.bridge.notifyBusy(this.convId);
    this.isStreaming = true;
    return this.sendCommand({
      id: id || `prompt-${Date.now()}`,
      type: 'prompt',
      message,
    });
  }

  abort() {
    return this.sendCommand({ id: `abort-${Date.now()}`, type: 'abort' });
  }

  newSession() {
    return this.sendCommand({ id: `new-${Date.now()}`, type: 'new_session' });
  }

  dispose() {
    this.disposed = true;
    if (this.process) {
      try {
        this.process.kill();
      } catch (e) {}
      this.process = null;
    }
    this._rejectAll('disposed');
  }
}

/* ==========================================================================
 * PiBridge：對外統一窗口，管理多個 PiProcess（一個對話一個程序）
 * ========================================================================== */
class PiBridge {
  constructor(mainWindow, app) {
    this.mainWindow = mainWindow;
    this.app = app;
    this.coreManager = new CoreManager(app);
    this.processes = new Map(); // convId -> PiProcess
    this.reclaimTimers = new Map(); // convId -> Timeout
    this.currentWorkspace = process.cwd();
    this.activeCoreInfo = null;
    this.activeConvId = null; // 目前畫面上開著的對話（閒置時保留，避免每次送出都重生）
  }

  // 初始化核心資訊（不主動開程序，改為前端 ensure 時才開）
  start(workspacePath) {
    if (workspacePath) this.currentWorkspace = workspacePath;
    this.activeCoreInfo = this.coreManager.resolveCore();
    console.log(`[PiBridge] 啟用核心: [${this.activeCoreInfo.type}] v${this.activeCoreInfo.version}`);
    console.log(`[PiBridge] 預設工作目錄: ${this.currentWorkspace}`);
    this.sendToRenderer('core:info', this.activeCoreInfo);
  }

  restart(workspacePath) {
    // 重啟核心：先把所有子程序關掉，之後前端再 ensure 時會用新核心重生
    for (const convId of Array.from(this.processes.keys())) {
      this.disposeProcess(convId);
    }
    this.start(workspacePath || this.currentWorkspace);
  }

  /* ---- 程序生命週期 -------------------------------------------------- */

  ensureSession(convId, opts = {}) {
    const { cwd, sessionFile } = opts;
    const existing = this.processes.get(convId);
    if (existing && !existing.disposed && existing.requestedSessionFile === (sessionFile || null)) {
      this.cancelReclaim(convId);
      return existing;
    }
    if (existing) existing.dispose();

    const proc = new PiProcess(this, convId, cwd || this.currentWorkspace, { sessionFile });
    this.processes.set(convId, proc);
    proc.start();
    return proc;
  }

  getProcess(convId) {
    return this.processes.get(convId) || null;
  }

  async ensureSessionReady(convId, opts = {}) {
    const proc = this.ensureSession(convId, opts);
    await proc.ready;
    // 重新取一次狀態，讓新對話落地後的 sessionFile 能被前端得知
    await proc.refreshState();
    return {
      convId,
      sessionFile: proc.sessionFile,
      sessionId: proc.sessionId,
      model: proc.model,
      workspace: proc.workspace,
    };
  }

  async prompt(convId, { message, id, cwd, sessionFile }) {
    let proc = this.processes.get(convId);
    if (!proc || proc.disposed) {
      proc = this.ensureSession(convId, { cwd, sessionFile });
    }
    // 等初始化（spawn / switch_session / get_state）完成，避免訊息送到錯誤的會話
    await proc.ready;
    return proc.prompt(message, id);
  }

  abort(convId) {
    const proc = this.processes.get(convId);
    if (proc) proc.abort();
  }

  async setModel(convId, provider, modelId) {
    const proc = this.processes.get(convId);
    if (proc) {
      await proc.ready;
      return await proc.setModel(provider, modelId);
    }
    return { success: false, error: 'Process not running' };
  }

  async setThinkingLevel(convId, level) {
    const proc = this.processes.get(convId);
    if (proc) {
      await proc.ready;
      return await proc.setThinkingLevel(level);
    }
    return { success: false, error: 'Process not running' };
  }

  disposeProcess(convId) {
    this.cancelReclaim(convId);
    const proc = this.processes.get(convId);
    if (proc) {
      proc.dispose();
      this.processes.delete(convId);
      console.log(`[PiBridge] 已回收程序: ${convId}`);
    }
  }

  /* ---- 回收策略：正在跑的一律保留，閒置且非當前檢視才回收 ---------- */

  setActive(convId) {
    const prev = this.activeConvId;
    this.activeConvId = convId || null;
    if (convId) this.cancelReclaim(convId);
    // 上一個正在看的對話若已閒置，排程回收
    if (prev && prev !== convId) {
      const p = this.processes.get(prev);
      if (p && !p.isStreaming) this.scheduleReclaim(prev);
    }
  }

  notifyBusy(convId) {
    const proc = this.processes.get(convId);
    if (proc) proc.isStreaming = true;
    this.cancelReclaim(convId);
  }

  onSettled(convId) {
    const proc = this.processes.get(convId);
    if (proc) proc.isStreaming = false;
    // 非當前檢視的對話，跑完後回收
    if (this.activeConvId !== convId) {
      this.scheduleReclaim(convId);
    }
  }

  scheduleReclaim(convId) {
    if (this.activeConvId === convId) return;
    if (this.reclaimTimers.has(convId)) return;
    const timer = setTimeout(() => {
      this.reclaimTimers.delete(convId);
      const proc = this.processes.get(convId);
      if (!proc) return;
      if (proc.isStreaming) return; // 又開始跑了
      if (this.activeConvId === convId) return; // 被切回當前檢視
      this.disposeProcess(convId);
    }, 1500);
    this.reclaimTimers.set(convId, timer);
  }

  cancelReclaim(convId) {
    const timer = this.reclaimTimers.get(convId);
    if (timer) {
      clearTimeout(timer);
      this.reclaimTimers.delete(convId);
    }
  }

  stop() {
    for (const convId of Array.from(this.processes.keys())) {
      this.disposeProcess(convId);
    }
  }

  /* ---- 對外檔案操作（與程序無關，維持原本行為） -------------------- */

  sendToRenderer(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  // 從目錄名稱粗略解碼出路徑 (僅在檔案讀不到 cwd 時的備援)
  decodeDirName(dirName) {
    return dirName.replace(/^--/, '').replace(/--$/, '').replace(/-/g, '\\');
  }

  // 在字串中尋找最後一筆 session_info 的 name（skipFirst=true 時略過首行，因它可能是跨區塊的殘行）
  findLastSessionInfoName(text, skipFirst) {
    const lines = text.split('\n');
    const startIdx = skipFirst ? 1 : 0;
    for (let i = lines.length - 1; i >= startIdx; i--) {
      const t = lines[i].trim();
      if (!t || t.indexOf('session_info') === -1) continue;
      try {
        const e = JSON.parse(t);
        if (e.type === 'session_info' && e.name) return e.name;
      } catch (err) { /* 忽略壞行 */ }
    }
    return null;
  }

  // 讀取單一 session 檔的中繼資料 (cwd / 首則使用者訊息 / session 名稱)
  readSessionMeta(filePath) {
    let fd = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const total = fs.fstatSync(fd).size;

      const headLen = Math.min(65536, total);
      const headBuf = Buffer.alloc(headLen);
      fs.readSync(fd, headBuf, 0, headLen, 0);
      let cwd = null;
      let firstUser = null;
      for (const line of headBuf.toString('utf-8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let entry;
        try { entry = JSON.parse(t); } catch (err) { continue; }
        if (entry.type === 'session' && entry.cwd && !cwd) cwd = entry.cwd;
        if (!firstUser && entry.type === 'message' && entry.message?.role === 'user') {
          firstUser = extractText(entry.message.content).trim();
        }
        if (cwd && firstUser) break;
      }

      let name = null;
      const MAX_SCAN = 8 * 1024 * 1024;
      const CHUNK = 131072;
      const chunks = [];
      let collected = 0;
      let end = total;
      while (end > 0 && collected < MAX_SCAN) {
        const start = Math.max(0, end - CHUNK);
        const len = end - start;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        chunks.unshift(buf);
        collected += len;
        end = start;
        name = this.findLastSessionInfoName(Buffer.concat(chunks).toString('utf-8'), end > 0);
        if (name) break;
      }

      return { cwd, firstUser, name };
    } catch (e) {
      return {};
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
    }
  }

  // 讀取真實的 Sessions (依 ~/.pi/agent/sessions 下的 .jsonl)
  listRealSessions() {
    const sessionsDir = path.join(os.homedir(), '.pi', 'agent', 'sessions');
    if (!fs.existsSync(sessionsDir)) return [];

    const projects = [];
    try {
      const dirs = fs.readdirSync(sessionsDir);
      for (const dirName of dirs) {
        const fullDirPath = path.join(sessionsDir, dirName);
        try {
          if (!fs.statSync(fullDirPath).isDirectory()) continue;
        } catch (e) { continue; }

        const sessionFiles = fs.readdirSync(fullDirPath).filter(f => f.endsWith('.jsonl'));
        if (sessionFiles.length === 0) continue;

        let cwd = null;
        const sessions = [];

        for (const file of sessionFiles) {
          const full = path.join(fullDirPath, file);
          const meta = this.readSessionMeta(full);
          if (!cwd && meta.cwd) cwd = meta.cwd;

          let stats;
          try { stats = fs.statSync(full); } catch (e) { continue; }

          const rawTitle = (meta.name || meta.firstUser || '').replace(/\s+/g, ' ').trim();
          sessions.push({
            id: full,
            filePath: full,
            projectId: null,
            title: rawTitle ? rawTitle.slice(0, 60) : file.replace(/\.jsonl$/, ''),
            timeAgo: timeAgo(stats.mtimeMs),
            updatedAt: stats.mtimeMs,
          });
        }

        sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        if (!cwd) cwd = this.decodeDirName(dirName);
        sessions.forEach(s => { s.projectId = cwd; });

        projects.push({
          id: cwd,
          name: path.basename(cwd) || dirName,
          path: cwd,
          sessions,
        });
      }
    } catch (e) {
      console.error('[PiBridge] 讀取 Sessions 失敗:', e);
    }

    projects.sort((a, b) => (b.sessions[0]?.updatedAt || 0) - (a.sessions[0]?.updatedAt || 0));
    return projects;
  }

  // 解析 .jsonl 成 UI 用的 Message[] (僅取目前作用中的分支)
  loadSession(filePath) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
      console.error('[PiBridge] 讀取會話檔失敗:', e);
      return [];
    }

    const entries = [];
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let e;
      try { e = JSON.parse(t); } catch (err) { continue; }
      entries.push(e);
    }

    const byId = new Map();
    entries.forEach(e => { if (e.id) byId.set(e.id, e); });
    let leaf = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].id) { leaf = entries[i]; break; }
    }

    const chain = [];
    const seen = new Set();
    let cur = leaf;
    while (cur && cur.id && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    chain.reverse();

    const messages = [];
    for (const entry of chain) {
      if (entry.type !== 'message' || !entry.message) continue;
      const m = entry.message;
      const ts = m.timestamp || Date.parse(entry.timestamp) || Date.now();

      if (m.role === 'user' || m.role === 'custom') {
        const text = extractText(m.content).trim();
        if (!text) continue;
        messages.push({ id: entry.id, role: 'user', content: text, timestamp: ts });
      } else if (m.role === 'assistant') {
        let text = '';
        let thinking = '';
        const tools = [];
        const parts = [];
        const blocks = Array.isArray(m.content) ? m.content : [];
        for (const b of blocks) {
          if (!b) continue;
          if (b.type === 'text') {
            text += b.text || '';
            parts.push({ type: 'text', text: b.text || '' });
          } else if (b.type === 'thinking') {
            thinking += b.thinking || '';
            parts.push({ type: 'thinking', text: b.thinking || '' });
          } else if (b.type === 'toolCall') {
            const tool = { id: b.id, name: b.name, args: b.arguments || {}, status: 'completed' };
            tools.push(tool);
            parts.push({ type: 'tool', tool });
          }
        }
        if (!text && !thinking && tools.length === 0) continue;
        messages.push({
          id: entry.id,
          role: 'assistant',
          content: text,
          thinking: thinking || undefined,
          tools: tools.length ? tools : undefined,
          parts: parts.length ? parts : undefined,
          timestamp: ts,
        });
      } else if (m.role === 'toolResult') {
        const out = extractText(m.content);
        for (let i = messages.length - 1; i >= 0; i--) {
          const found = messages[i].tools?.find(x => x.id === m.toolCallId);
          if (found) {
            found.output = out;
            found.status = m.isError ? 'failed' : 'completed';
            // edit 工具的 diff 存在 toolResult.details.diff
            if (typeof m.details?.diff === 'string') found.diff = m.details.diff;
            break;
          }
        }
      }
    }

    return messages;
  }

  // 重新命名對話：對 .jsonl 追加一筆標準 session_info entry
  renameSession(filePath, name) {
    try {
      let content = fs.readFileSync(filePath, 'utf-8');
      if (!content.endsWith('\n')) {
        fs.appendFileSync(filePath, '\n', 'utf-8');
        content += '\n';
      }

      const lines = content.split('\n').filter(l => l.trim());
      let lastId = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const e = JSON.parse(lines[i]);
          if (e.id) { lastId = e.id; break; }
        } catch (err) { /* 忽略壞行 */ }
      }

      const entry = {
        type: 'session_info',
        id: randomBytes(4).toString('hex'),
        parentId: lastId,
        timestamp: new Date().toISOString(),
        name,
      };
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
      return { success: true };
    } catch (e) {
      console.error('[PiBridge] 重新命名失敗:', e);
      return { success: false, error: e.message };
    }
  }

  // 複製整個對話
  duplicateSession(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const newId = randomUUID();
      const iso = new Date().toISOString();
      let headerReplaced = false;

      const outLines = content.split('\n').map((line) => {
        const t = line.trim();
        if (!t || headerReplaced) return line;
        try {
          const e = JSON.parse(t);
          if (e.type === 'session') {
            headerReplaced = true;
            e.id = newId;
            e.timestamp = iso;
            e.parentSession = filePath;
            return JSON.stringify(e);
          }
        } catch (err) { /* 忽略壞行 */ }
        return line;
      });

      const stamp = iso.replace(/[:.]/g, '-');
      const newFileName = `${stamp}_${newId}.jsonl`;
      const newPath = path.join(path.dirname(filePath), newFileName);
      fs.writeFileSync(newPath, outLines.join('\n'), 'utf-8');
      return { success: true, path: newPath };
    } catch (e) {
      console.error('[PiBridge] 複製對話失敗:', e);
      return { success: false, error: e.message };
    }
  }

  // 匯出 JSONL：直接複製原始檔
  copySessionFile(filePath, outputPath) {
    try {
      fs.copyFileSync(filePath, outputPath);
      return { success: true, path: outputPath };
    } catch (e) {
      console.error('[PiBridge] 匯出 JSONL 失敗:', e);
      return { success: false, error: e.message };
    }
  }

  // 匯出 HTML：用 Pi 官方 CLI `--export <來源> <目標>`
  exportSessionHtml(filePath, outputPath) {
    return new Promise((resolve) => {
      const core = this.activeCoreInfo || this.coreManager.resolveCore();
      const meta = this.readSessionMeta(filePath);
      const cwd = meta.cwd || this.currentWorkspace;

      let child;
      if (core.cliPath) {
        child = spawn('node', [core.cliPath, '--export', filePath, outputPath], {
          cwd,
          windowsHide: true,
        });
      } else {
        child = spawn('cmd.exe', ['/c', 'pi', '--export', filePath, outputPath], {
          cwd,
          windowsHide: true,
        });
      }

      let stderr = '';
      if (child.stdout) child.stdout.on('data', () => {});
      if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => resolve({ success: false, error: err.message }));
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve({ success: true, path: outputPath });
        } else {
          resolve({ success: false, error: stderr.trim() || `匯出程序結束碼 ${code}` });
        }
      });
    });
  }
}

module.exports = { PiBridge };
