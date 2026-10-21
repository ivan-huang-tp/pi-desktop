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
    terminalManager = new TerminalManager(() => mainWindow);
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
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
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
    piBridge.start(process.cwd());
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
ipcMain.on('pi:send-prompt', (event, { convId, message, id, cwd, sessionFile }) => {
  if (piBridge) {
    piBridge.prompt(convId, { message, id, cwd, sessionFile });
  }
});

ipcMain.on('pi:abort', (event, { convId } = {}) => {
  if (piBridge) {
    piBridge.abort(convId);
  }
});

// 確保某個對話的子程序存在（需要時才開，閒置會被回收）
ipcMain.handle('pi:ensure-session', (event, { convId, cwd, sessionFile }) => {
  if (!piBridge) return null;
  return piBridge.ensureSessionReady(convId, { cwd, sessionFile });
});

// 告知目前畫面上開著的對話（正在檢視的閒置程序不回收）
ipcMain.on('pi:set-active', (event, { convId } = {}) => {
  if (piBridge) piBridge.setActive(convId);
});

// 手動回收某對話的子程序
ipcMain.on('pi:dispose-session', (event, { convId } = {}) => {
  if (piBridge) piBridge.disposeProcess(convId);
});

ipcMain.handle('pi:get-real-projects', () => {
  if (piBridge) {
    return piBridge.listRealSessions();
  }
  return [];
});

// 載入指定 session 的歷史訊息（純讀檔，不再切換任何程序的核心會話）
ipcMain.handle('pi:load-session', (event, filePath) => {
  if (!piBridge) return [];
  return piBridge.loadSession(filePath);
});

// 重新命名對話
ipcMain.handle('pi:rename-session', (event, { filePath, name }) => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  return piBridge.renameSession(filePath, name);
});

// 複製整個對話
ipcMain.handle('pi:duplicate-session', (event, filePath) => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  return piBridge.duplicateSession(filePath);
});

// 刪除對話：優先丟資源回收筒（trash），失敗才直接刪除
ipcMain.handle('pi:delete-session', async (event, filePath) => {
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
ipcMain.handle('pi:export-session', (event, { filePath, format, outputPath }) => {
  if (!piBridge) return { success: false, error: 'Bridge not ready' };
  if (format === 'jsonl') return piBridge.copySessionFile(filePath, outputPath);
  return piBridge.exportSessionHtml(filePath, outputPath);
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

// 真實讀取 Workspace 檔案樹
ipcMain.handle('fs:read-directory', async (event, dirPath) => {
  const targetDir = dirPath || process.cwd();
  function scan(currentPath, depth = 0) {
    if (depth > 2) return []; // 限制深度以免太大
    try {
      const items = fs.readdirSync(currentPath);
      return items
        .filter(item => !item.startsWith('.') && item !== 'node_modules' && item !== 'dist' && item !== 'reference')
        .map(item => {
          const full = path.join(currentPath, item);
          const isDir = fs.statSync(full).isDirectory();
          return {
            name: item,
            path: path.relative(targetDir, full),
            isDirectory: isDir,
            children: isDir ? scan(full, depth + 1) : undefined,
          };
        });
    } catch (e) {
      return [];
    }
  }
  return scan(targetDir);
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
