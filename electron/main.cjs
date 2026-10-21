const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PiBridge } = require('./pi-bridge.cjs');
const { TerminalManager } = require('./terminal-manager.cjs');

let mainWindow = null;
let piBridge = null;
let terminalManager = null;
function getTerminalManager() {
  if (!terminalManager) {
    const { TerminalManager } = require('./terminal-manager.cjs');
    terminalManager = new TerminalManager(() => mainWindow, () => piBridge?.sshManager);
  }
  return terminalManager;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#121214',
    autoHideMenuBar: true,
    title: 'Pi Agent Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  const distPath = path.join(__dirname, '../dist/index.html');
  const devUrl = process.env.ELECTRON_DEV_URL;

  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else if (fs.existsSync(distPath)) {
    mainWindow.loadFile(distPath);
  } else {
    mainWindow.loadURL('http://localhost:5173');
  }

  // 啟動 Pi RPC Bridge (傳入 app 供 CoreManager 解析 userData)
  piBridge = new PiBridge(mainWindow, app);
  mainWindow.webContents.on('did-finish-load', () => {
    // 安裝版從開始選單啟動時 cwd 是安裝目錄，不適合當預設工作區
    piBridge.start(app.isPackaged ? os.homedir() : process.cwd());
  });

  mainWindow.on('closed', () => {
    if (piBridge) piBridge.stop();
    if (terminalManager) terminalManager.killAll();
    mainWindow = null;
  });
  // 重新載入頁面時，舊的終端機已無人接收，一併關閉
  mainWindow.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace && terminalManager) terminalManager.killAll();
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (piBridge) piBridge.stop();
  if (terminalManager) terminalManager.killAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 使用者互動式終端機（全部改為 lazy 取得，App 啟動完全不碰 node-pty）
ipcMain.handle('term:list-shells', () => getTerminalManager().listShells());
ipcMain.handle('term:create', (event, opts) => getTerminalManager().create(opts));
ipcMain.on('term:write', (event, { id, data }) => getTerminalManager().write(id, data));
ipcMain.on('term:resize', (event, { id, cols, rows }) => getTerminalManager().resize(id, cols, rows));
ipcMain.on('term:kill', (event, { id }) => getTerminalManager().kill(id));

// 註冊 IPC 監聽
ipcMain.on('pi:send-prompt', (event, { convId, message, id, cwd, sessionFile, ssh }) => {
  if (piBridge) {
    piBridge.prompt(convId, { message, id, cwd, sessionFile, ssh });
  }
});

ipcMain.on('pi:abort', (event, { convId } = {}) => {
  if (piBridge) {
    piBridge.abort(convId);
  }
});

// 確保某個對話的子程序存在（需要時才開，閒置會被回收）
ipcMain.handle('pi:ensure-session', (event, { convId, cwd, sessionFile, ssh }) => {
  if (!piBridge) return null;
  return piBridge.ensureSessionReady(convId, { cwd, sessionFile, ssh });
});

// 告知目前畫面上開著的對話（正在檢視的閒置程序不回收）
ipcMain.on('pi:set-active', (event, { convId } = {}) => {
  if (piBridge) piBridge.setActive(convId);
});

// 手動回收某對話的子程序
ipcMain.on('pi:dispose-session', (event, { convId } = {}) => {
  if (piBridge) piBridge.disposeProcess(convId);
});

ipcMain.handle('pi:get-real-projects', async () => {
  if (piBridge) {
    return await piBridge.listRealSessions();
  }
  return [];
});

// 載入指定 session 的歷史訊息（純讀檔，不再切換任何程序的核心會話）
ipcMain.handle('pi:load-session', async (event, arg) => {
  if (!piBridge) return [];
  if (typeof arg === 'string') return await piBridge.loadSession(arg, null);
  return await piBridge.loadSession(arg?.filePath, arg?.ssh || null);
});

// 重新命名對話
ipcMain.handle('pi:rename-session', async (event, { filePath, name, ssh }) => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  return await piBridge.renameSession(filePath, name, ssh || null);
});

// 複製整個對話
ipcMain.handle('pi:duplicate-session', async (event, arg) => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  if (typeof arg === 'string') return await piBridge.duplicateSession(arg, null);
  return await piBridge.duplicateSession(arg?.filePath, arg?.ssh || null);
});

// 刪除對話：優先丟資源回收筒（trash），失敗才直接刪除（遠端對話透過 SSH 刪除）
ipcMain.handle('pi:delete-session', async (event, arg) => {
  const filePath = typeof arg === 'string' ? arg : arg?.filePath;
  const ssh = typeof arg === 'object' ? arg?.ssh : null;
  if (ssh && piBridge) {
    return await piBridge.sshManager.deleteRemoteSession(ssh, filePath);
  }
  try {
    await shell.trashItem(filePath);
    return { success: true, trashed: true };
  } catch (err) {
    try {
      fs.rmSync(filePath, { force: true });
      return { success: true, trashed: false };
    } catch (e2) {
      return { success: false, error: e2.message };
    }
  }
});

// 匯出對話（html / jsonl）
ipcMain.handle('pi:export-session', async (event, { filePath, format, outputPath, ssh }) => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  if (format === 'jsonl') return await piBridge.copySessionFile(filePath, outputPath, ssh || null);
  return await piBridge.exportSessionHtml(filePath, outputPath, ssh || null);
});

// 單一訊息粒度操作：切換同層分支版本 (< 1/N >)
ipcMain.handle('pi:switch-branch', async (event, { filePath, targetLeafId, ssh, convId }) => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  return await piBridge.switchBranch(filePath, targetLeafId, ssh || null, convId || null);
});

// 單一訊息粒度操作：回溯至指定使用者訊息之前（供編輯重送 / 重新生成使用）
ipcMain.handle('pi:rewind-before-entry', async (event, { filePath, entryId, userTurnIndex, messageText, ssh, convId }) => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  return await piBridge.rewindBeforeEntry(
    filePath,
    { entryId, userTurnIndex, messageText },
    ssh || null,
    convId || null
  );
});

// 單一訊息粒度操作：從指定使用者訊息處分支出新對話檔 (Fork)
ipcMain.handle('pi:fork-session', async (event, { filePath, entryId, userTurnIndex, messageText, ssh }) => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  return await piBridge.forkFromEntry(filePath, { entryId, userTurnIndex, messageText }, ssh || null);
});

// 單一訊息粒度操作：設定或移除書籤標籤 (LabelEntry)
ipcMain.handle('pi:set-entry-label', async (event, { filePath, entryId, userTurnIndex, messageText, label, ssh, convId }) => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  return await piBridge.setEntryLabel(
    filePath,
    { entryId, userTurnIndex, messageText, label },
    ssh || null,
    convId || null
  );
});

// 單一訊息粒度操作：切換是否從 AI 上下文略過此回合 (ContextEditEntry)
ipcMain.handle('pi:toggle-context-omit', async (event, { filePath, entryId, userTurnIndex, messageText, omit, ssh, convId }) => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  return await piBridge.toggleContextOmit(
    filePath,
    { entryId, userTurnIndex, messageText, omit },
    ssh || null,
    convId || null
  );
});

// SSH 遠端專案與目錄瀏覽 IPC Handlers
ipcMain.handle('ssh:browse-dir', async (event, { ssh, targetPath }) => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  return await piBridge.sshManager.browseRemoteDir(ssh, targetPath);
});

ipcMain.handle('ssh:mkdir', async (event, { ssh, dirPath }) => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  return await piBridge.sshManager.mkdirRemote(ssh, dirPath);
});

ipcMain.handle('ssh:save-project', async (event, { ssh, remotePath, name }) => {
  if (!piBridge) return null;
  return piBridge.sshManager.saveRemoteProject({ ssh, remotePath, name });
});

ipcMain.handle('ssh:remove-project', async (event, projectId) => {
  if (!piBridge) return { success: false };
  return piBridge.sshManager.removeRemoteProject(projectId);
});

ipcMain.handle('ssh:get-saved-hosts', async () => {
  if (!piBridge) return [];
  return piBridge.sshManager.getSavedHosts();
});

// 另存新檔對話框
ipcMain.handle('dialog:save-file', async (event, { defaultPath, filters }) => {
  if (!mainWindow) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath,
    filters: filters || [],
  });
  return result.canceled ? null : result.filePath;
});

// 在檔案總管中顯示 / 開啟
ipcMain.handle('shell:show-item', (event, filePath) => {
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('shell:open-path', async (event, targetPath) => {
  return await shell.openPath(targetPath);
});

// 寫入剪貼簿
ipcMain.handle('clipboard:write', (event, text) => {
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('dialog:openDirectory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  // 不在這裡啟動橋接，交由渲染層決定（例如 pi:ensure-session）
  return result.filePaths[0] || null;
});

// 真實讀取目錄內容（支援本機與 SSH 遠端、包含隱藏檔、單層即時導覽與上一層路徑）
ipcMain.handle('fs:read-directory', async (event, arg) => {
  const dirPath = typeof arg === 'string' ? arg : arg?.dirPath;
  const ssh = typeof arg === 'object' ? arg?.ssh : null;
  if (ssh && piBridge) {
    return await piBridge.sshManager.readRemoteWorkspaceTree(ssh, dirPath);
  }

  let currentPath = path.resolve(dirPath || process.cwd());
  try {
    if (!fs.existsSync(currentPath)) {
      const parentPath = path.dirname(currentPath) !== currentPath ? path.dirname(currentPath) : null;
      return {
        success: false,
        error: `目錄不存在: ${currentPath}`,
        currentPath,
        parentPath,
        items: [],
      };
    }

    const st = fs.statSync(currentPath);
    if (!st.isDirectory()) {
      currentPath = path.dirname(currentPath);
    }

    const parentPath = path.dirname(currentPath) !== currentPath ? path.dirname(currentPath) : null;
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      const name = entry.name;
      const full = path.join(currentPath, name);
      let isDir = entry.isDirectory();
      let size = undefined;
      let mtimeMs = undefined;
      try {
        if (entry.isSymbolicLink()) {
          const itemStat = fs.statSync(full);
          isDir = itemStat.isDirectory();
          size = isDir ? undefined : itemStat.size;
          mtimeMs = itemStat.mtimeMs;
        } else if (!isDir) {
          const itemStat = fs.statSync(full);
          size = itemStat.size;
          mtimeMs = itemStat.mtimeMs;
        }
      } catch {}

      items.push({
        name,
        path: full,
        isDirectory: isDir,
        size,
        mtimeMs,
        isHidden: name.startsWith('.'),
      });
    }

    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    return {
      success: true,
      currentPath,
      parentPath,
      items,
    };
  } catch (e) {
    return {
      success: false,
      error: e.message || String(e),
      currentPath,
      parentPath: path.dirname(currentPath) !== currentPath ? path.dirname(currentPath) : null,
      items: [],
    };
  }
});

// 讀取單一檔案內容（支援本機與 SSH 遠端、文字、圖片 Base64、SVG 雙模態、二進位偵測）
ipcMain.handle('fs:read-file', async (event, arg) => {
  const filePath = typeof arg === 'string' ? arg : arg?.filePath;
  const ssh = typeof arg === 'object' ? arg?.ssh : null;
  if (ssh && piBridge) {
    return await piBridge.sshManager.readRemoteFile(ssh, filePath);
  }

  try {
    const resolved = path.resolve(String(filePath));
    if (!fs.existsSync(resolved)) {
      return { success: false, error: `找不到檔案: ${resolved}` };
    }
    const st = fs.statSync(resolved);
    if (st.isDirectory()) {
      return { success: false, error: '目標路徑是資料夾而非檔案' };
    }

    const name = path.basename(resolved);
    const ext = path.extname(name).toLowerCase();
    const IMAGE_MIMES = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.bmp': 'image/bmp',
      '.avif': 'image/avif',
    };

    const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 2MB
    const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB

    if (IMAGE_MIMES[ext]) {
      if (st.size > MAX_IMAGE_BYTES) {
        return {
          success: true,
          filePath: resolved,
          name,
          kind: 'binary',
          size: st.size,
        };
      }
      const buf = fs.readFileSync(resolved);
      const mime = IMAGE_MIMES[ext];
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      const content = ext === '.svg' && st.size <= MAX_TEXT_BYTES ? buf.toString('utf-8') : undefined;
      return {
        success: true,
        filePath: resolved,
        name,
        kind: 'image',
        dataUrl,
        content,
        size: st.size,
      };
    }

    const readLen = Math.min(st.size, MAX_TEXT_BYTES);
    const fd = fs.openSync(resolved, 'r');
    const buf = Buffer.alloc(readLen);
    try {
      fs.readSync(fd, buf, 0, readLen, 0);
    } finally {
      fs.closeSync(fd);
    }

    // 檢查前 8KB 是否含有 null byte (0x00)
    const checkLen = Math.min(readLen, 8192);
    for (let i = 0; i < checkLen; i++) {
      if (buf[i] === 0) {
        return {
          success: true,
          filePath: resolved,
          name,
          kind: 'binary',
          size: st.size,
        };
      }
    }

    return {
      success: true,
      filePath: resolved,
      name,
      kind: 'text',
      content: buf.toString('utf-8'),
      size: st.size,
      truncated: st.size > MAX_TEXT_BYTES,
    };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

// 寫入單一檔案內容（支援本機與 SSH 遠端）
ipcMain.handle('fs:write-file', async (event, arg) => {
  const { filePath, content, ssh } = arg || {};
  if (!filePath) return { success: false, error: '缺少檔案路徑' };
  if (ssh && piBridge) {
    return await piBridge.sshManager.writeRemoteFile(ssh, filePath, content);
  }
  try {
    const resolved = path.resolve(String(filePath));
    fs.writeFileSync(resolved, String(content ?? ''), 'utf-8');
    const st = fs.statSync(resolved);
    return { success: true, size: st.size };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

// 建立新檔案或新資料夾（支援本機與 SSH 遠端）
ipcMain.handle('fs:create-item', async (event, arg) => {
  const { parentDir, name, isDirectory, ssh } = arg || {};
  if (ssh && piBridge) {
    return await piBridge.sshManager.createRemoteItem(ssh, { parentDir, name, isDirectory });
  }
  try {
    const cleanName = String(name || '').trim();
    if (!cleanName || cleanName.includes('/') || cleanName.includes('\\')) {
      return { success: false, error: '無效的名稱' };
    }
    const targetPath = path.join(path.resolve(String(parentDir)), cleanName);
    if (fs.existsSync(targetPath)) {
      return { success: false, error: `已存在同名檔案或資料夾: ${cleanName}` };
    }
    if (isDirectory) {
      fs.mkdirSync(targetPath, { recursive: true });
    } else {
      fs.writeFileSync(targetPath, '', 'utf-8');
    }
    return { success: true, path: targetPath };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

// 重新命名檔案或資料夾（支援本機與 SSH 遠端）
ipcMain.handle('fs:rename-item', async (event, arg) => {
  const { oldPath, newName, ssh } = arg || {};
  if (ssh && piBridge) {
    return await piBridge.sshManager.renameRemoteItem(ssh, { oldPath, newName });
  }
  try {
    const cleanName = String(newName || '').trim();
    if (!cleanName || cleanName.includes('/') || cleanName.includes('\\')) {
      return { success: false, error: '無效的名稱' };
    }
    const resolvedOld = path.resolve(String(oldPath));
    const newPath = path.join(path.dirname(resolvedOld), cleanName);
    if (resolvedOld === newPath) {
      return { success: true, path: newPath };
    }
    if (resolvedOld.toLowerCase() !== newPath.toLowerCase() && fs.existsSync(newPath)) {
      return { success: false, error: `目標名稱已存在: ${cleanName}` };
    }
    fs.renameSync(resolvedOld, newPath);
    return { success: true, path: newPath };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

// 拖曳移動一個或多個檔案/資料夾（支援本機與 SSH 遠端）
ipcMain.handle('fs:move-items', async (event, arg) => {
  const { sourcePaths, targetDir, ssh } = arg || {};
  if (ssh && piBridge) {
    return await piBridge.sshManager.moveRemoteItems(ssh, { sourcePaths, targetDir });
  }
  try {
    const resolvedTargetDir = path.resolve(String(targetDir));
    if (!fs.existsSync(resolvedTargetDir) || !fs.statSync(resolvedTargetDir).isDirectory()) {
      return { success: false, error: '目標資料夾不存在' };
    }
    for (const src of sourcePaths || []) {
      const resolvedSrc = path.resolve(String(src));
      if (!fs.existsSync(resolvedSrc)) continue;
      if (
        resolvedTargetDir.toLowerCase() === resolvedSrc.toLowerCase() ||
        resolvedTargetDir.toLowerCase().startsWith(resolvedSrc.toLowerCase() + path.sep)
      ) {
        return { success: false, error: '無法將資料夾移入自身或其子目錄' };
      }
      const baseName = path.basename(resolvedSrc);
      const destPath = path.join(resolvedTargetDir, baseName);
      if (resolvedSrc.toLowerCase() === destPath.toLowerCase()) continue;
      if (fs.existsSync(destPath)) {
        return { success: false, error: `目標資料夾已存在同名項目: ${baseName}` };
      }
      try {
        fs.renameSync(resolvedSrc, destPath);
      } catch {
        fs.cpSync(resolvedSrc, destPath, { recursive: true });
        fs.rmSync(resolvedSrc, { recursive: true, force: true });
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

// 貼上（複製或剪下）一個或多個檔案/資料夾，自動處理同名副本（支援本機與 SSH 遠端）
ipcMain.handle('fs:paste-items', async (event, arg) => {
  const { sourcePaths, targetDir, mode, ssh } = arg || {};
  if (ssh && piBridge) {
    return await piBridge.sshManager.pasteRemoteItems(ssh, { sourcePaths, targetDir, mode });
  }
  try {
    const resolvedTargetDir = path.resolve(String(targetDir));
    if (!fs.existsSync(resolvedTargetDir) || !fs.statSync(resolvedTargetDir).isDirectory()) {
      return { success: false, error: '目標資料夾不存在' };
    }

    function getUniqueDestPath(dir, name, isDir) {
      const candidate = path.join(dir, name);
      if (!fs.existsSync(candidate)) return candidate;
      const ext = isDir ? '' : path.extname(name);
      const base = isDir ? name : name.slice(0, name.length - ext.length);
      let idx = 1;
      while (true) {
        const suffix = idx === 1 ? ' copy' : ` copy ${idx}`;
        const nextPath = path.join(dir, `${base}${suffix}${ext}`);
        if (!fs.existsSync(nextPath)) return nextPath;
        idx++;
      }
    }

    for (const src of sourcePaths || []) {
      const resolvedSrc = path.resolve(String(src));
      if (!fs.existsSync(resolvedSrc)) continue;
      if (resolvedTargetDir.toLowerCase().startsWith(resolvedSrc.toLowerCase() + path.sep)) {
        return { success: false, error: '無法將資料夾複製或移入其子目錄內' };
      }
      const st = fs.statSync(resolvedSrc);
      const isDir = st.isDirectory();
      const baseName = path.basename(resolvedSrc);
      if (mode === 'cut') {
        if (path.dirname(resolvedSrc).toLowerCase() === resolvedTargetDir.toLowerCase()) continue;
        const destPath = getUniqueDestPath(resolvedTargetDir, baseName, isDir);
        try {
          fs.renameSync(resolvedSrc, destPath);
        } catch {
          fs.cpSync(resolvedSrc, destPath, { recursive: true });
          fs.rmSync(resolvedSrc, { recursive: true, force: true });
        }
      } else {
        const destPath = getUniqueDestPath(resolvedTargetDir, baseName, isDir);
        fs.cpSync(resolvedSrc, destPath, { recursive: true });
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

// 刪除一個或多個檔案/資料夾（本機優先移至資源回收筒，SSH 遠端直接刪除）
ipcMain.handle('fs:delete-items', async (event, arg) => {
  const { paths, ssh } = arg || {};
  if (ssh && piBridge) {
    return await piBridge.sshManager.deleteRemoteItems(ssh, { paths });
  }
  try {
    let allTrashed = true;
    for (const p of paths || []) {
      const resolved = path.resolve(String(p));
      try {
        await shell.trashItem(resolved);
      } catch {
        allTrashed = false;
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
    return { success: true, trashed: allTrashed };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

// 核心動態更新管理 IPC Handlers
ipcMain.handle('core:get-status', async () => {
  if (!piBridge) return null;
  return piBridge.coreManager.resolveCore();
});

ipcMain.handle('core:check-update', async () => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  return await piBridge.coreManager.checkForUpdates();
});

ipcMain.handle('core:do-update', async (event, targetVersion) => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  return await piBridge.coreManager.installUpdate(targetVersion, (log) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('core:update-log', log);
    }
  });
});

ipcMain.handle('core:reset-bundled', async () => {
  if (!piBridge) return false;
  const ok = piBridge.coreManager.resetToBundled();
  if (ok) {
    piBridge.restart();
  }
  return ok;
});

ipcMain.handle('core:restart', async () => {
  if (piBridge) {
    piBridge.restart();
    return true;
  }
  return false;
});

// 模型細項設定 IPC Handlers
ipcMain.handle('model:get-config', async () => {
  try {
    const agentDir = path.join(os.homedir(), '.pi', 'agent');
    const modelsPath = path.join(agentDir, 'models.json');
    const settingsPath = path.join(agentDir, 'settings.json');

    let modelsConfig = { providers: {} };
    let settingsConfig = {};

    if (fs.existsSync(modelsPath)) {
      try {
        modelsConfig = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
      } catch (e) {
        console.error('[main] models.json 解析錯誤:', e);
      }
    }

    if (fs.existsSync(settingsPath)) {
      try {
        settingsConfig = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      } catch (e) {
        console.error('[main] settings.json 解析錯誤:', e);
      }
    }

    return {
      success: true,
      agentDir,
      modelsConfig,
      settingsConfig,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('model:save-config', async (event, { modelsConfig, settingsConfig, applyToActiveSession, convId }) => {
  try {
    const agentDir = path.join(os.homedir(), '.pi', 'agent');
    const modelsPath = path.join(agentDir, 'models.json');
    const settingsPath = path.join(agentDir, 'settings.json');

    if (!fs.existsSync(agentDir)) {
      fs.mkdirSync(agentDir, { recursive: true });
    }

    if (modelsConfig) {
      fs.writeFileSync(modelsPath, JSON.stringify(modelsConfig, null, 2), 'utf-8');
    }

    if (settingsConfig) {
      fs.writeFileSync(settingsPath, JSON.stringify(settingsConfig, null, 2), 'utf-8');
    }

    // 若勾選同時套用至進行中對話
    if (applyToActiveSession && convId && piBridge) {
      const provider = settingsConfig?.defaultProvider;
      const modelId = settingsConfig?.defaultModel;
      if (provider && modelId) {
        try {
          await piBridge.setModel(convId, provider, modelId);
        } catch (e) {
          console.warn('[PiBridge] setModel 失敗:', e);
        }
      }
      if (settingsConfig?.defaultThinkingLevel) {
        try {
          await piBridge.setThinkingLevel(convId, settingsConfig.defaultThinkingLevel);
        } catch (e) {
          console.warn('[PiBridge] setThinkingLevel 失敗:', e);
        }
      }
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('model:set-runtime', async (event, { convId, provider, modelId, thinkingLevel }) => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  try {
    const results = {};
    if (provider && modelId) {
      results.model = await piBridge.setModel(convId, provider, modelId);
    }
    if (thinkingLevel) {
      results.thinking = await piBridge.setThinkingLevel(convId, thinkingLevel);
    }
    return { success: true, results };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
