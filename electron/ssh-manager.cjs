const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const START_MARKER = '__PI_UI_JSON_START__';
const END_MARKER = '__PI_UI_JSON_END__';

// 主程序注入的 tracer（未啟用時所有 trace 呼叫都是 no-op）
let tracer = null;
function setTracer(t) {
  tracer = t;
}
function tr(category, message, data) {
  if (tracer) tracer.log(category, message, data);
}

// 將字串安全包成 POSIX 單引號字串：'abc' -> 'abc', a'b -> 'a'\''b'
function quotePosix(str) {
  const s = String(str ?? '');
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// 遠端 POSIX sh 環境初始化：自動載入常見的 Node.js / Pi 安裝路徑（nvm, fnm, volta, bun, .local/bin 等）
const REMOTE_PATH_SETUP = [
  'export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.bun/bin:$HOME/.volta/bin:$HOME/.npm-global/bin:$HOME/.yarn/bin:$HOME/.asdf/shims:$HOME/.asdf/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"',
  'if [ -d "$HOME/.nvm/versions/node" ]; then for d in "$HOME/.nvm/versions/node"/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done; fi',
  'if [ -d "$HOME/.local/share/fnm/node-versions" ]; then for d in "$HOME/.local/share/fnm/node-versions"/*/installation/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done; fi',
  'if [ -d "$HOME/.fnm/node-versions" ]; then for d in "$HOME/.fnm/node-versions"/*/installation/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done; fi',
  'if [ -d "$HOME/.local/share/mise/installs/node" ]; then for d in "$HOME/.local/share/mise/installs/node"/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done; fi',
  '[ -f "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1 || true',
  'export PATH',
].join('; ');

class SshManager {
  constructor(app) {
    this.app = app;
    this.askPassScriptPath = null;
    this._ensureAskPassHelper();
  }

  // 取得儲存 SSH 專案設定的檔案路徑
  getStorageFile() {
    const userDataPath = this.app
      ? this.app.getPath('userData')
      : path.join(process.env.APPDATA || process.env.HOME || '.', '.pi-ui');
    if (!fs.existsSync(userDataPath)) {
      try {
        fs.mkdirSync(userDataPath, { recursive: true });
      } catch {}
    }
    return path.join(userDataPath, 'ssh-projects.json');
  }

  // 讀取已儲存的遠端專案與主機記錄
  loadSavedData() {
    const file = this.getStorageFile();
    if (!fs.existsSync(file)) {
      return { projects: [], hosts: [] };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return {
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        hosts: Array.isArray(parsed.hosts) ? parsed.hosts : [],
      };
    } catch (e) {
      console.error('[SshManager] 讀取 ssh-projects.json 失敗:', e);
      return { projects: [], hosts: [] };
    }
  }

  saveData(data) {
    const file = this.getStorageFile();
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (e) {
      console.error('[SshManager] 寫入 ssh-projects.json 失敗:', e);
      return false;
    }
  }

  // 取得所有已儲存的 SSH 專案
  getSavedProjects() {
    return this.loadSavedData().projects;
  }

  // 取得所有曾連線過的 SSH 主機設定
  getSavedHosts() {
    return this.loadSavedData().hosts;
  }

  // 正規化 SshConfig
  normalizeSshConfig(ssh) {
    if (!ssh || !ssh.host) return null;
    let rawHost = String(ssh.host).trim().replace(/^ssh\s+/i, '');
    let port = ssh.port ? Number(ssh.port) : undefined;

    // 支援使用者直接在 host 欄貼上 "-p 2222 user@host"
    const portMatch = rawHost.match(/(?:^|\s)-p\s*(\d+)(?:\s|$)/);
    if (portMatch) {
      port = Number(portMatch[1]);
      rawHost = rawHost.replace(portMatch[0], ' ').trim();
    }

    const id = `${rawHost}:${port || 22}`;
    return {
      id,
      host: rawHost,
      port: port && port !== 22 ? port : undefined,
      password: ssh.password || undefined,
      label: ssh.label || rawHost,
    };
  }

  // 儲存或更新一個遠端專案（同時記住該 SSH 主機）
  saveRemoteProject({ ssh, remotePath, name }) {
    const normSsh = this.normalizeSshConfig(ssh);
    if (!normSsh || !remotePath) return null;

    const cleanPath = String(remotePath).replace(/\/+$/, '') || '/';
    const projId = `ssh://${normSsh.id}${cleanPath.startsWith('/') ? '' : '/'}${cleanPath}`;
    const projName = name || path.posix.basename(cleanPath) || cleanPath;

    const data = this.loadSavedData();
    const existingHostIdx = data.hosts.findIndex((h) => h.id === normSsh.id);
    if (existingHostIdx >= 0) {
      data.hosts[existingHostIdx] = normSsh;
    } else {
      data.hosts.unshift(normSsh);
    }

    const projectEntry = {
      id: projId,
      name: projName,
      path: cleanPath,
      ssh: normSsh,
      addedAt: Date.now(),
    };

    const existingProjIdx = data.projects.findIndex((p) => p.id === projId);
    if (existingProjIdx >= 0) {
      data.projects[existingProjIdx] = projectEntry;
    } else {
      data.projects.unshift(projectEntry);
    }

    this.saveData(data);
    return projectEntry;
  }

  // 移除已儲存的遠端專案（不刪除遠端檔案）
  removeRemoteProject(projectId) {
    const data = this.loadSavedData();
    data.projects = data.projects.filter((p) => p.id !== projectId && p.path !== projectId);
    this.saveData(data);
    return { success: true };
  }

  // 準備 SSH_ASKPASS 輔助腳本（當使用者提供密碼時，自動回答密碼或 yes/no）
  _ensureAskPassHelper() {
    try {
      const dir = path.join(os.tmpdir(), 'pi-ui-ssh-helper');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const jsPath = path.join(dir, 'askpass.cjs');
      const jsContent = [
        'const prompt = (process.argv.slice(2).join(" ") || "").toLowerCase();',
        'if (prompt.includes("yes/no") || prompt.includes("continue connecting")) {',
        '  process.stdout.write("yes\\n");',
        '} else {',
        '  process.stdout.write((process.env.PI_UI_SSH_PASS || "") + "\\n");',
        '}',
      ].join('\n');
      fs.writeFileSync(jsPath, jsContent, 'utf-8');

      if (process.platform === 'win32') {
        const batPath = path.join(dir, 'askpass.bat');
        // process.execPath 在打包後是「Pi Agent Desktop.exe」而不是 node.exe；
        // 設定 ELECTRON_RUN_AS_NODE=1 就能把它當純 node 執行，使用者不需要另外安裝 Node.js。
        const batContent = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${jsPath}" %*\r\n`;
        fs.writeFileSync(batPath, batContent, 'utf-8');
        this.askPassScriptPath = batPath;
      } else {
        const shPath = path.join(dir, 'askpass.sh');
        const shContent = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${jsPath}" "$@"\n`;
        fs.writeFileSync(shPath, shContent, { encoding: 'utf-8', mode: 0o700 });
        this.askPassScriptPath = shPath;
      }
    } catch (e) {
      console.error('[SshManager] 建立 SSH_ASKPASS 腳本失敗:', e);
    }
  }

  // 建立給 child_process.spawn / node-pty 使用的環境變數
  buildSshEnv(ssh) {
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
    if (ssh && ssh.password && this.askPassScriptPath) {
      env.SSH_ASKPASS = this.askPassScriptPath;
      env.SSH_ASKPASS_REQUIRE = 'force';
      env.DISPLAY = env.DISPLAY || '1';
      env.PI_UI_SSH_PASS = String(ssh.password);
    }
    return env;
  }

  // 建立給 ssh 執行檔的基礎參數陣列
  buildSshBaseArgs(ssh, { interactive = false } = {}) {
    const norm = this.normalizeSshConfig(ssh);
    const args = [      interactive ? '-t' : '-T',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
    ];

    if (!norm.password) {
      // 無密碼時啟用 BatchMode，避免背景程序因等待輸入密碼而無限期卡死
      args.push('-o', 'BatchMode=yes');
    }

    if (norm.port && norm.port !== 22) {
      args.push('-p', String(norm.port));
    }

    // 允許 host 中帶有額外空白參數（例如使用者填了 "-i ~/.ssh/id_rsa user@host"）
    const tokens = norm.host.split(/\s+/).filter(Boolean);
    args.push(...tokens);
    return args;
  }

  // 在遠端執行一段 POSIX sh 腳本並啟動 pi --mode rpc（供 PiProcess 使用）
  spawnRemotePiRpc(ssh, remoteCwd) {
    const shBody = [
      REMOTE_PATH_SETUP,
      `cd ${quotePosix(remoteCwd)} || exit 1`,
      'if command -v pi >/dev/null 2>&1; then',
      '  exec pi --mode rpc',
      'elif command -v bash >/dev/null 2>&1; then',
      `  exec bash -lc ${quotePosix(`cd ${quotePosix(remoteCwd)} && exec pi --mode rpc`)}`,
      'else',
      `  exec sh -lc ${quotePosix(`cd ${quotePosix(remoteCwd)} && exec pi --mode rpc`)}`,
      'fi',
    ].join('\n');

    const remoteCmd = `sh -c ${quotePosix(shBody)}`;
    const args = [...this.buildSshBaseArgs(ssh, { interactive: false }), remoteCmd];
    const env = this.buildSshEnv(ssh);

    const norm = this.normalizeSshConfig(ssh);
    tr('ssh:spawn', '啟動遠端 pi rpc', { host: norm?.host, port: norm?.port || 22, remoteCwd });

    const proc = spawn('ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });

    proc.on('error', (err) => {
      tr('ssh:spawn', '遠端 pi rpc 啟動失敗', { host: norm?.host, error: err.message });
    });
    proc.on('close', (code, signal) => {
      tr('ssh:spawn', '遠端 pi rpc 結束', { host: norm?.host, code, signal });
    });
    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) tr('ssh:stderr', `host=${norm?.host}`, { text });
      });
    }

    return proc;
  }

  // 在遠端透過 Base64 + 標記安全執行一段 Node.js 函式並取回 JSON 結果
  execRemoteNode(ssh, fnSource, payload = {}, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const norm = this.normalizeSshConfig(ssh);
      if (!norm) {
        return resolve({ success: false, error: '無效的 SSH 主機設定' });
      }

      const wrappedJs = `(async () => {
  try {
    const payload = ${JSON.stringify(payload)};
    const fn = ${fnSource};
    const data = await fn(payload);
    process.stdout.write(${JSON.stringify(START_MARKER)} + JSON.stringify({ ok: true, data }) + ${JSON.stringify(END_MARKER)} + "\\n");
  } catch (err) {
    process.stdout.write(${JSON.stringify(START_MARKER)} + JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }) + ${JSON.stringify(END_MARKER)} + "\\n");
  }
})();
`.trim();

      const b64 = Buffer.from(wrappedJs, 'utf-8').toString('base64');
      // 小腳本走 argv（沿用原本行為），大腳本改走 stdin。
      // 原因：node -e "eval(...)" 是把整包 base64 塞進「單一命令列參數」，
      // 會撞上 Linux 的 MAX_ARG_STRLEN。
      // 2026-10-21 對 bfgpuubuntu 實測：script 60KB（base64 80KB）仍 OK，
      // script 100KB（base64 133KB）→ `Argument list too long`。
      // 門檻取 60000 是留給 env 與外層 shell 的安全餘量，
      // 超過就走 stdin（實測 2.6MB base64 仍然正常）。
      const ARGV_LIMIT = 60000;
      const useStdin = b64.length > ARGV_LIMIT;

      const nodeArgvCmd = `node -e "eval(Buffer.from('${b64}','base64').toString())"`;
      // 從 fd 0 讀 base64 後再 eval，參數長度固定，與 payload 大小無關
      // 注意：這裡的 stdin 是「腳本本身」的 base64（payload 內嵌在腳本裡）
      const nodeStdinCmd = `node -e "eval(Buffer.from(require('fs').readFileSync(0,'utf8'),'base64').toString())"`;
      const nodeCmd = useStdin ? nodeStdinCmd : nodeArgvCmd;

      const shBody = [
        REMOTE_PATH_SETUP,
        'if command -v node >/dev/null 2>&1; then',
        `  ${nodeCmd}`,
        'elif command -v bash >/dev/null 2>&1; then',
        `  bash -lc ${quotePosix(nodeCmd)}`,
        'else',
        '  echo "REMOTE_NODE_MISSING" >&2; exit 127',
        'fi',
      ].join('\n');

      const remoteCmd = `sh -c ${quotePosix(shBody)}`;
      const args = [...this.buildSshBaseArgs(norm, { interactive: false }), remoteCmd];
      const env = this.buildSshEnv(norm);

      tr('ssh:execNode', '遠端 Node 呼叫', {
        host: norm.host,
        payloadBytes: b64.length,
        transport: useStdin ? 'stdin' : 'argv',
        timeoutMs,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const child = spawn('ssh', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        windowsHide: true,
      });

      // 大 payload 走 stdin：寫入後務必 end()，遠端 node 才會收到 EOF
      if (useStdin) {
        try {
          child.stdin.end(b64);
        } catch (e) {
          tr('ssh:execNode', '寫入 stdin 失敗', { host: norm.host, error: e.message });
        }
      } else {
        try {
          child.stdin.end();
        } catch {
          /* ignore */
        }
      }

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch {}
        tr('ssh:execNode', '遠端 Node 呼叫逾時', { host: norm.host, transport: useStdin ? 'stdin' : 'argv' });
        resolve({ success: false, error: 'SSH 連線逾時（請確認主機位址、網路或認證設定）' });
      }, timeoutMs);

      child.stdout.on('data', (d) => { stdout += d.toString('utf-8'); });
      child.stderr.on('data', (d) => { stderr += d.toString('utf-8'); });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        tr('ssh:execNode', '無法啟動 ssh', { host: norm.host, error: err.message });
        resolve({ success: false, error: `無法啟動系統 ssh：${err.message}` });
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const sIdx = stdout.indexOf(START_MARKER);
        const eIdx = stdout.indexOf(END_MARKER);
        if (sIdx !== -1 && eIdx !== -1 && eIdx > sIdx) {
          const jsonStr = stdout.slice(sIdx + START_MARKER.length, eIdx);
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.ok) {
              return resolve({ success: true, data: parsed.data });
            }
            return resolve({ success: false, error: parsed.error || '遠端執行錯誤' });
          } catch (e) {
            return resolve({ success: false, error: `解析遠端回應失敗：${e.message}` });
          }
        }

        const errText = stderr.trim() || stdout.trim() || `SSH 結束代碼 ${code}`;
        if (errText.includes('REMOTE_NODE_MISSING')) {
          return resolve({ success: false, error: '遠端主機找不到 node 指令，請確認遠端已安裝 Node.js 與 pi' });
        }
        if (errText.toLowerCase().includes('permission denied')) {
          return resolve({ success: false, error: `SSH 認證失敗 (Permission denied)：請確認 SSH Key 或輸入正確密碼` });
        }
        tr('ssh:execNode', '遠端 Node 呼叫失敗', {
          host: norm.host,
          transport: useStdin ? 'stdin' : 'argv',
          code,
          stdout: stdout.slice(0, 2000),
          stderr: stderr.slice(0, 2000),
        });
        resolve({ success: false, error: errText });
      });
    });
  }

  /* ==========================================================================
   * 遠端操作 API
   * ========================================================================== */

  // 1. 測試連線 + 瀏覽遠端目錄 + 探索遠端既有 Pi 專案
  async browseRemoteDir(ssh, targetPath = '') {
    const fnSource = `async ({ targetPath }) => {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const { execSync } = require('child_process');

      const homeDir = os.homedir();
      let currentPath = targetPath ? String(targetPath).trim() : homeDir;
      if (currentPath === '~') currentPath = homeDir;
      else if (currentPath.startsWith('~/')) currentPath = path.join(homeDir, currentPath.slice(2));
      currentPath = path.resolve(currentPath);

      if (!fs.existsSync(currentPath) || !fs.statSync(currentPath).isDirectory()) {
        currentPath = homeDir;
      }

      const parentPath = path.dirname(currentPath) !== currentPath ? path.dirname(currentPath) : null;

      // 列出子目錄
      const items = fs.readdirSync(currentPath, { withFileTypes: true });
      const directories = [];
      for (const item of items) {
        if (item.name.startsWith('.')) continue;
        let isDir = item.isDirectory();
        if (item.isSymbolicLink()) {
          try { isDir = fs.statSync(path.join(currentPath, item.name)).isDirectory(); } catch {}
        }
        if (isDir) {
          directories.push({
            name: item.name,
            path: path.posix.join(currentPath.replace(/\\\\/g, '/'), item.name),
          });
        }
      }
      directories.sort((a, b) => a.name.localeCompare(b.name));

      // 檢查 pi 是否可用
      let piPath = null;
      try {
        piPath = execSync('command -v pi', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {}

      // 探索 ~/.pi/agent/sessions 下既有的專案
      const discoveredProjects = [];
      const sessionsDir = path.join(homeDir, '.pi', 'agent', 'sessions');
      if (fs.existsSync(sessionsDir)) {
        try {
          const dirs = fs.readdirSync(sessionsDir);
          for (const dirName of dirs) {
            const fullDir = path.join(sessionsDir, dirName);
            try { if (!fs.statSync(fullDir).isDirectory()) continue; } catch { continue; }
            const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.jsonl'));
            if (files.length === 0) continue;

            let cwd = null;
            let latestMs = 0;
            for (const f of files) {
              const fullFile = path.join(fullDir, f);
              try {
                const st = fs.statSync(fullFile);
                if (st.mtimeMs > latestMs) latestMs = st.mtimeMs;
                if (!cwd) {
                  const fd = fs.openSync(fullFile, 'r');
                  const buf = Buffer.alloc(Math.min(16384, st.size));
                  fs.readSync(fd, buf, 0, buf.length, 0);
                  fs.closeSync(fd);
                  for (const line of buf.toString('utf-8').split('\\n')) {
                    const t = line.trim();
                    if (!t) continue;
                    try {
                      const e = JSON.parse(t);
                      if (e.type === 'session' && e.cwd) { cwd = e.cwd; break; }
                    } catch {}
                  }
                }
              } catch {}
            }
            if (cwd) {
              discoveredProjects.push({
                path: cwd,
                name: path.basename(cwd) || cwd,
                sessionCount: files.length,
                updatedAt: latestMs,
              });
            }
          }
          discoveredProjects.sort((a, b) => b.updatedAt - a.updatedAt);
        } catch {}
      }

      return {
        currentPath: currentPath.replace(/\\\\/g, '/'),
        parentPath: parentPath ? parentPath.replace(/\\\\/g, '/') : null,
        homeDir: homeDir.replace(/\\\\/g, '/'),
        directories,
        discoveredProjects,
        piAvailable: !!piPath,
        piPath,
        nodeVersion: process.version,
      };
    }`;

    const res = await this.execRemoteNode(ssh, fnSource, { targetPath });
    if (!res.success) return { success: false, error: res.error };
    return { success: true, ...res.data };
  }

  // 2. 在遠端建立新資料夾
  async mkdirRemote(ssh, dirPath) {
    const fnSource = `async ({ dirPath }) => {
      const fs = require('fs');
      const path = require('path');
      const resolved = path.resolve(String(dirPath));
      fs.mkdirSync(resolved, { recursive: true });
      return { path: resolved.replace(/\\\\/g, '/') };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { dirPath });
    if (!res.success) return { success: false, error: res.error };
    return { success: true, path: res.data.path };
  }

  // 3. 讀取遠端目錄內容（支援隱藏檔、單層即時導覽與上一層路徑，對應 fs:read-directory）
  async readRemoteWorkspaceTree(ssh, targetDir) {
    const fnSource = `async ({ targetDir }) => {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const homeDir = os.homedir();
      let currentPath = targetDir ? String(targetDir).trim() : homeDir;
      if (currentPath === '~') currentPath = homeDir;
      else if (currentPath.startsWith('~/')) currentPath = path.join(homeDir, currentPath.slice(2));
      currentPath = path.resolve(currentPath);

      if (!fs.existsSync(currentPath)) {
        return {
          success: false,
          error: '遠端目錄不存在: ' + currentPath,
          currentPath: currentPath.replace(/\\\\/g, '/'),
          parentPath: path.dirname(currentPath) !== currentPath ? path.dirname(currentPath).replace(/\\\\/g, '/') : null,
          items: [],
        };
      }

      const stat = fs.statSync(currentPath);
      if (!stat.isDirectory()) {
        currentPath = path.dirname(currentPath);
      }

      const parentPath = path.dirname(currentPath) !== currentPath
        ? path.dirname(currentPath).replace(/\\\\/g, '/')
        : null;

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
            const st = fs.statSync(full);
            isDir = st.isDirectory();
            size = isDir ? undefined : st.size;
            mtimeMs = st.mtimeMs;
          } else if (!isDir) {
            const st = fs.statSync(full);
            size = st.size;
            mtimeMs = st.mtimeMs;
          }
        } catch {}

        items.push({
          name,
          path: full.replace(/\\\\/g, '/'),
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
        currentPath: currentPath.replace(/\\\\/g, '/'),
        parentPath,
        items,
      };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { targetDir });
    if (!res.success) {
      return {
        success: false,
        error: res.error,
        currentPath: targetDir || '',
        parentPath: null,
        items: [],
      };
    }
    return res.data;
  }

  // 3b. 讀取遠端單一檔案內容（支援文字、圖片 Base64、SVG 雙模態、二進位偵測）
  async readRemoteFile(ssh, filePath) {
    const fnSource = `async ({ filePath }) => {
      const fs = require('fs');
      const path = require('path');
      const resolved = path.resolve(String(filePath));
      if (!fs.existsSync(resolved)) {
        throw new Error('找不到檔案: ' + resolved);
      }
      const st = fs.statSync(resolved);
      if (st.isDirectory()) {
        throw new Error('目標路徑是資料夾而非檔案');
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
            filePath: resolved.replace(/\\\\/g, '/'),
            name,
            kind: 'binary',
            size: st.size,
          };
        }
        const buf = fs.readFileSync(resolved);
        const mime = IMAGE_MIMES[ext];
        const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
        const content = ext === '.svg' && st.size <= MAX_TEXT_BYTES ? buf.toString('utf-8') : undefined;
        return {
          filePath: resolved.replace(/\\\\/g, '/'),
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

      // 檢查前 8KB 是否含有 null byte (0x00) 判斷是否為二進位檔
      const checkLen = Math.min(readLen, 8192);
      for (let i = 0; i < checkLen; i++) {
        if (buf[i] === 0) {
          return {
            filePath: resolved.replace(/\\\\/g, '/'),
            name,
            kind: 'binary',
            size: st.size,
          };
        }
      }

      return {
        filePath: resolved.replace(/\\\\/g, '/'),
        name,
        kind: 'text',
        content: buf.toString('utf-8'),
        size: st.size,
        truncated: st.size > MAX_TEXT_BYTES,
      };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { filePath }, 25000);
    if (!res.success) return { success: false, error: res.error };
    return { success: true, ...res.data };
  }

  // 3c. 寫入遠端單一檔案內容（UTF-8）
  async writeRemoteFile(ssh, filePath, content) {
    const fnSource = `async ({ filePath, content }) => {
      const fs = require('fs');
      const path = require('path');
      const resolved = path.resolve(String(filePath));
      fs.writeFileSync(resolved, String(content ?? ''), 'utf-8');
      const st = fs.statSync(resolved);
      return { size: st.size };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { filePath, content }, 25000);
    if (!res.success) return { success: false, error: res.error };
    return { success: true, ...res.data };
  }

  // 3d. 在遠端建立新檔案或新資料夾
  async createRemoteItem(ssh, { parentDir, name, isDirectory }) {
    const fnSource = `async ({ parentDir, name, isDirectory }) => {
      const fs = require('fs');
      const path = require('path');
      const cleanName = String(name || '').trim();
      if (!cleanName || cleanName.includes('/') || cleanName.includes('\\\\')) {
        throw new Error('無效的名稱');
      }
      const targetPath = path.join(path.resolve(String(parentDir)), cleanName);
      if (fs.existsSync(targetPath)) {
        throw new Error('已存在同名檔案或資料夾: ' + cleanName);
      }
      if (isDirectory) {
        fs.mkdirSync(targetPath, { recursive: true });
      } else {
        fs.writeFileSync(targetPath, '', 'utf-8');
      }
      return { path: targetPath.replace(/\\\\/g, '/') };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { parentDir, name, isDirectory });
    if (!res.success) return { success: false, error: res.error };
    return { success: true, ...res.data };
  }

  // 3e. 在遠端重新命名檔案或資料夾
  async renameRemoteItem(ssh, { oldPath, newName }) {
    const fnSource = `async ({ oldPath, newName }) => {
      const fs = require('fs');
      const path = require('path');
      const cleanName = String(newName || '').trim();
      if (!cleanName || cleanName.includes('/') || cleanName.includes('\\\\')) {
        throw new Error('無效的名稱');
      }
      const resolvedOld = path.resolve(String(oldPath));
      const newPath = path.join(path.dirname(resolvedOld), cleanName);
      if (resolvedOld === newPath) {
        return { path: newPath.replace(/\\\\/g, '/') };
      }
      if (resolvedOld.toLowerCase() !== newPath.toLowerCase() && fs.existsSync(newPath)) {
        throw new Error('目標名稱已存在: ' + cleanName);
      }
      fs.renameSync(resolvedOld, newPath);
      return { path: newPath.replace(/\\\\/g, '/') };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { oldPath, newName });
    if (!res.success) return { success: false, error: res.error };
    return { success: true, ...res.data };
  }

  // 3f. 在遠端拖曳移動一個或多個檔案/資料夾
  async moveRemoteItems(ssh, { sourcePaths, targetDir }) {
    const fnSource = `async ({ sourcePaths, targetDir }) => {
      const fs = require('fs');
      const path = require('path');
      const resolvedTargetDir = path.resolve(String(targetDir));
      if (!fs.existsSync(resolvedTargetDir) || !fs.statSync(resolvedTargetDir).isDirectory()) {
        throw new Error('目標資料夾不存在');
      }
      for (const src of sourcePaths || []) {
        const resolvedSrc = path.resolve(String(src));
        if (!fs.existsSync(resolvedSrc)) continue;
        if (resolvedTargetDir === resolvedSrc || resolvedTargetDir.startsWith(resolvedSrc + path.sep)) {
          throw new Error('無法將資料夾移入自身或其子目錄');
        }
        const baseName = path.basename(resolvedSrc);
        const destPath = path.join(resolvedTargetDir, baseName);
        if (resolvedSrc === destPath) continue;
        if (fs.existsSync(destPath)) {
          throw new Error('目標資料夾已存在同名項目: ' + baseName);
        }
        try {
          fs.renameSync(resolvedSrc, destPath);
        } catch (err) {
          fs.cpSync(resolvedSrc, destPath, { recursive: true });
          fs.rmSync(resolvedSrc, { recursive: true, force: true });
        }
      }
      return { ok: true };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { sourcePaths, targetDir }, 30000);
    if (!res.success) return { success: false, error: res.error };
    return { success: true };
  }

  // 3g. 在遠端貼上（複製或剪下）一個或多個檔案/資料夾（自動處理同名副本）
  async pasteRemoteItems(ssh, { sourcePaths, targetDir, mode }) {
    const fnSource = `async ({ sourcePaths, targetDir, mode }) => {
      const fs = require('fs');
      const path = require('path');
      const resolvedTargetDir = path.resolve(String(targetDir));
      if (!fs.existsSync(resolvedTargetDir) || !fs.statSync(resolvedTargetDir).isDirectory()) {
        throw new Error('目標資料夾不存在');
      }

      function getUniqueDestPath(dir, name, isDir) {
        const candidate = path.join(dir, name);
        if (!fs.existsSync(candidate)) return candidate;
        const ext = isDir ? '' : path.extname(name);
        const base = isDir ? name : name.slice(0, name.length - ext.length);
        let idx = 1;
        while (true) {
          const suffix = idx === 1 ? ' copy' : ' copy ' + idx;
          const nextPath = path.join(dir, base + suffix + ext);
          if (!fs.existsSync(nextPath)) return nextPath;
          idx++;
        }
      }

      for (const src of sourcePaths || []) {
        const resolvedSrc = path.resolve(String(src));
        if (!fs.existsSync(resolvedSrc)) continue;
        if (resolvedTargetDir.startsWith(resolvedSrc + path.sep)) {
          throw new Error('無法將資料夾複製或移入其子目錄內');
        }
        const st = fs.statSync(resolvedSrc);
        const isDir = st.isDirectory();
        const baseName = path.basename(resolvedSrc);
        if (mode === 'cut') {
          if (path.dirname(resolvedSrc) === resolvedTargetDir) continue;
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
      return { ok: true };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { sourcePaths, targetDir, mode }, 30000);
    if (!res.success) return { success: false, error: res.error };
    return { success: true };
  }

  // 3h. 在遠端刪除一個或多個檔案/資料夾
  async deleteRemoteItems(ssh, { paths }) {
    const fnSource = `async ({ paths }) => {
      const fs = require('fs');
      const path = require('path');
      for (const p of paths || []) {
        const resolved = path.resolve(String(p));
        if (resolved === '/' || resolved === '') continue;
        fs.rmSync(resolved, { recursive: true, force: true });
      }
      return { ok: true };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { paths }, 25000);
    if (!res.success) return { success: false, error: res.error };
    return { success: true, trashed: false };
  }

  // 4. 列出某台遠端主機上的所有 Pi 專案與歷史 Sessions
  async listRemoteSessionsForHost(ssh) {
    const normSsh = this.normalizeSshConfig(ssh);
    if (!normSsh) return [];

    const fnSource = `async () => {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');

      function extractText(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content
            .filter(b => b && b.type === 'text' && typeof b.text === 'string')
            .map(b => b.text)
            .join('\\n');
        }
        return '';
      }

      function timeAgo(ms) {
        const diff = Date.now() - ms;
        const m = Math.floor(diff / 60000);
        if (m < 1) return 'Now';
        if (m < 60) return m + 'm';
        const h = Math.floor(m / 60);
        if (h < 24) return h + 'h';
        const d = Math.floor(h / 24);
        if (d < 7) return d + 'd';
        return new Date(ms).toLocaleDateString();
      }

      function findLastSessionInfoName(text, skipFirst) {
        const lines = text.split('\\n');
        const startIdx = skipFirst ? 1 : 0;
        for (let i = lines.length - 1; i >= startIdx; i--) {
          const t = lines[i].trim();
          if (!t || t.indexOf('session_info') === -1) continue;
          try {
            const e = JSON.parse(t);
            if (e.type === 'session_info' && e.name) return e.name;
          } catch {}
        }
        return null;
      }

      function readSessionMeta(filePath) {
        let fd = null;
        try {
          fd = fs.openSync(filePath, 'r');
          const total = fs.fstatSync(fd).size;
          const headLen = Math.min(65536, total);
          const headBuf = Buffer.alloc(headLen);
          fs.readSync(fd, headBuf, 0, headLen, 0);
          let cwd = null;
          let firstUser = null;
          for (const line of headBuf.toString('utf-8').split('\\n')) {
            const t = line.trim();
            if (!t) continue;
            let entry;
            try { entry = JSON.parse(t); } catch { continue; }
            if (entry.type === 'session' && entry.cwd && !cwd) cwd = entry.cwd;
            if (!firstUser && entry.type === 'message' && entry.message && entry.message.role === 'user') {
              firstUser = extractText(entry.message.content).trim();
            }
            if (cwd && firstUser) break;
          }

          let name = null;
          const MAX_SCAN = 2 * 1024 * 1024;
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
            name = findLastSessionInfoName(Buffer.concat(chunks).toString('utf-8'), end > 0);
            if (name) break;
          }
          return { cwd, firstUser, name };
        } catch {
          return {};
        } finally {
          if (fd !== null) { try { fs.closeSync(fd); } catch {} }
        }
      }

      const sessionsDir = path.join(os.homedir(), '.pi', 'agent', 'sessions');
      if (!fs.existsSync(sessionsDir)) return [];

      const projects = [];
      const dirs = fs.readdirSync(sessionsDir);
      for (const dirName of dirs) {
        const fullDirPath = path.join(sessionsDir, dirName);
        try { if (!fs.statSync(fullDirPath).isDirectory()) continue; } catch { continue; }
        const sessionFiles = fs.readdirSync(fullDirPath).filter(f => f.endsWith('.jsonl'));
        if (sessionFiles.length === 0) continue;

        let cwd = null;
        const sessions = [];
        for (const file of sessionFiles) {
          const full = path.join(fullDirPath, file);
          const meta = readSessionMeta(full);
          if (!cwd && meta.cwd) cwd = meta.cwd;
          let stats;
          try { stats = fs.statSync(full); } catch { continue; }
          const rawTitle = (meta.name || meta.firstUser || '').replace(/\\s+/g, ' ').trim();
          sessions.push({
            filePath: full.replace(/\\\\/g, '/'),
            title: rawTitle ? rawTitle.slice(0, 60) : file.replace(/\\.jsonl$/, ''),
            timeAgo: timeAgo(stats.mtimeMs),
            updatedAt: stats.mtimeMs,
          });
        }
        sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        if (!cwd) {
          cwd = '/' + dirName.replace(/^--/, '').replace(/--$/, '').replace(/-/g, '/');
        }
        projects.push({
          name: path.basename(cwd) || dirName,
          path: cwd.replace(/\\\\/g, '/'),
          sessions,
        });
      }
      return projects;
    }`;

    const res = await this.execRemoteNode(normSsh, fnSource, {}, 12000);
    if (!res.success || !Array.isArray(res.data)) return [];

    return res.data.map((proj) => {
      const cleanPath = String(proj.path).replace(/\/+$/, '') || '/';
      const projId = `ssh://${normSsh.id}${cleanPath.startsWith('/') ? '' : '/'}${cleanPath}`;
      return {
        id: projId,
        name: proj.name,
        path: cleanPath,
        ssh: normSsh,
        sessions: (proj.sessions || []).map((s) => ({
          id: `ssh://${normSsh.id}${s.filePath}`,
          filePath: s.filePath,
          projectId: projId,
          title: s.title,
          timeAgo: s.timeAgo,
          updatedAt: s.updatedAt,
          ssh: normSsh,
        })),
      };
    });
  }

  // 遠端共用的 Session Tree 解析與輔助函式片段
  _remoteSessionHelperCode() {
    return `
      const fs = require('fs');
      const path = require('path');
      const { randomBytes, randomUUID } = require('crypto');

      function extractText(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content
            .filter(b => b && b.type === 'text' && typeof b.text === 'string')
            .map(b => b.text)
            .join('\\n');
        }
        return '';
      }

      function genEntryId(byId) {
        for (let i = 0; i < 100; i++) {
          const id = randomBytes(4).toString('hex');
          if (!byId || !byId.has(id)) return id;
        }
        return randomUUID().slice(0, 8);
      }

      function appendJsonlEntries(filePath, newEntries) {
        if (!newEntries || newEntries.length === 0) return;
        const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
        const prefix = content.length > 0 && !content.endsWith('\\n') ? '\\n' : '';
        const payload = prefix + newEntries.map(e => JSON.stringify(e)).join('\\n') + '\\n';
        fs.appendFileSync(filePath, payload, 'utf-8');
      }

      function parseSessionData(content) {
        const entries = [];
        let header = null;
        for (const line of content.split('\\n')) {
          const t = line.trim();
          if (!t) continue;
          let e;
          try { e = JSON.parse(t); } catch { continue; }
          if (e.type === 'session' && !header) header = e;
          entries.push(e);
        }

        const byId = new Map();
        const labelsById = new Map();
        const labelTimestampsById = new Map();
        let leaf = null;

        for (const e of entries) {
          if (e.type === 'session') continue;
          if (e.id) {
            byId.set(e.id, e);
            leaf = e;
          }
          if (e.type === 'label' && e.targetId) {
            if (e.label) {
              labelsById.set(e.targetId, e.label);
              labelTimestampsById.set(e.targetId, e.timestamp);
            } else {
              labelsById.delete(e.targetId);
              labelTimestampsById.delete(e.targetId);
            }
          }
        }

        const isUserMessageEntry = (e) => {
          if (!e || !e.id) return false;
          if (e.type === 'message' && e.message && (e.message.role === 'user' || e.message.role === 'custom')) {
            return extractText(e.message.content).trim().length > 0;
          }
          if (e.type === 'custom_message' && e.display !== false) {
            return extractText(e.content).trim().length > 0;
          }
          return false;
        };

        const nearestUserAncestor = new Map();
        const siblingsByParentUser = new Map();
        const latestLeafByUserEntryId = new Map();

        for (const e of entries) {
          if (e.type === 'session' || !e.id) continue;

          if (isUserMessageEntry(e)) {
            let p = e.parentId ? byId.get(e.parentId) : null;
            const visited = new Set([e.id]);
            let ancestorUserId = null;
            while (p && p.id && !visited.has(p.id)) {
              visited.add(p.id);
              if (isUserMessageEntry(p)) {
                ancestorUserId = p.id;
                break;
              }
              p = p.parentId ? byId.get(p.parentId) : null;
            }
            nearestUserAncestor.set(e.id, ancestorUserId);
            if (!siblingsByParentUser.has(ancestorUserId)) {
              siblingsByParentUser.set(ancestorUserId, []);
            }
            siblingsByParentUser.get(ancestorUserId).push(e);
            if (!latestLeafByUserEntryId.has(e.id)) {
              latestLeafByUserEntryId.set(e.id, e.id);
            }
          }

          const isBookkeeping =
            e.type === 'label' ||
            e.type === 'session_info' ||
            (e.type === 'custom' && e.customType === 'pi-ui:branch');
          if (!isBookkeeping) {
            let cur = e;
            const visited = new Set();
            while (cur && cur.id && !visited.has(cur.id)) {
              visited.add(cur.id);
              if (isUserMessageEntry(cur)) {
                latestLeafByUserEntryId.set(cur.id, e.id);
              }
              cur = cur.parentId ? byId.get(cur.parentId) : null;
            }
          }
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

        const contextEdits = new Map();
        for (const e of chain) {
          if (e.type === 'context_edit' && e.targetId) {
            contextEdits.set(e.targetId, e.replacement);
          }
        }

        const messages = [];
        for (const entry of chain) {
          if (entry.type === 'custom_message' && entry.display !== false) {
            const text = extractText(entry.content).trim();
            if (!text) continue;
            const ts = Date.parse(entry.timestamp) || Date.now();
            const parentUserKey = nearestUserAncestor.get(entry.id) ?? null;
            const siblingGroup = siblingsByParentUser.get(parentUserKey) || [entry];
            const branchIdx = siblingGroup.findIndex(s => s.id === entry.id);
            const siblingLeafIds = siblingGroup.map(s => latestLeafByUserEntryId.get(s.id) || s.id);
            const omitted = contextEdits.get(entry.id) === null;
            const label = labelsById.get(entry.id);
            messages.push({
              id: entry.id,
              parentId: entry.parentId ?? null,
              role: 'user',
              content: text,
              timestamp: ts,
              branchIndex: branchIdx >= 0 ? branchIdx + 1 : 1,
              branchCount: siblingGroup.length,
              siblingLeafIds: siblingGroup.length > 1 ? siblingLeafIds : undefined,
              label: label || undefined,
              omitted: omitted || undefined,
            });
            continue;
          }

          if (entry.type !== 'message' || !entry.message) continue;
          const m = entry.message;
          const ts = m.timestamp || Date.parse(entry.timestamp) || Date.now();

          if (m.role === 'user' || m.role === 'custom') {
            const text = extractText(m.content).trim();
            if (!text) continue;
            const parentUserKey = nearestUserAncestor.get(entry.id) ?? null;
            const siblingGroup = siblingsByParentUser.get(parentUserKey) || [entry];
            const branchIdx = siblingGroup.findIndex(s => s.id === entry.id);
            const siblingLeafIds = siblingGroup.map(s => latestLeafByUserEntryId.get(s.id) || s.id);
            const omitted = contextEdits.get(entry.id) === null;
            const label = labelsById.get(entry.id);
            messages.push({
              id: entry.id,
              parentId: entry.parentId ?? null,
              role: 'user',
              content: text,
              timestamp: ts,
              branchIndex: branchIdx >= 0 ? branchIdx + 1 : 1,
              branchCount: siblingGroup.length,
              siblingLeafIds: siblingGroup.length > 1 ? siblingLeafIds : undefined,
              label: label || undefined,
              omitted: omitted || undefined,
            });
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
            const omitted = contextEdits.get(entry.id) === null;
            messages.push({
              id: entry.id,
              parentId: entry.parentId ?? null,
              role: 'assistant',
              content: text,
              thinking: thinking || undefined,
              tools: tools.length ? tools : undefined,
              parts: parts.length ? parts : undefined,
              timestamp: ts,
              omitted: omitted || undefined,
            });
          } else if (m.role === 'toolResult') {
            const out = extractText(m.content);
            for (let i = messages.length - 1; i >= 0; i--) {
              const found = messages[i].tools && messages[i].tools.find(x => x.id === m.toolCallId);
              if (found) {
                found.output = out;
                found.status = m.isError ? 'failed' : 'completed';
                if (m.details && typeof m.details.diff === 'string') found.diff = m.details.diff;
                break;
              }
            }
          }
        }

        return {
          header,
          entries,
          byId,
          labelsById,
          labelTimestampsById,
          leaf,
          chain,
          messages,
          isUserMessageEntry,
        };
      }

      function resolveTargetUserEntry(parsed, spec = {}) {
        const { byId, chain, isUserMessageEntry } = parsed;
        if (spec.entryId && byId.has(spec.entryId)) {
          return byId.get(spec.entryId);
        }
        const userEntries = chain.filter(isUserMessageEntry);
        if (typeof spec.userTurnIndex === 'number' && spec.userTurnIndex >= 0 && spec.userTurnIndex < userEntries.length) {
          return userEntries[spec.userTurnIndex];
        }
        if (spec.messageText) {
          const targetText = String(spec.messageText).trim();
          for (let i = userEntries.length - 1; i >= 0; i--) {
            const u = userEntries[i];
            const t = extractText(u.type === 'custom_message' ? u.content : u.message?.content).trim();
            if (t === targetText) return u;
          }
        }
        return null;
      }
    `;
  }

  // 5. 載入指定遠端 .jsonl 會話的訊息歷史（含分支/書籤/Context 略過狀態）
  async loadRemoteSession(ssh, remoteFilePath) {
    const fnSource = `async ({ remoteFilePath }) => {
      ${this._remoteSessionHelperCode()}
      const content = fs.readFileSync(remoteFilePath, 'utf-8');
      return parseSessionData(content).messages;
    }`;

    const res = await this.execRemoteNode(ssh, fnSource, { remoteFilePath });
    return res.success && Array.isArray(res.data) ? res.data : [];
  }

  // 5b. 切換遠端會話的同層分支版本 (< 1/N >)
  async switchRemoteBranch(ssh, remoteFilePath, targetLeafId) {
    const fnSource = `async ({ remoteFilePath, targetLeafId }) => {
      ${this._remoteSessionHelperCode()}
      const content = fs.readFileSync(remoteFilePath, 'utf-8');
      const parsed = parseSessionData(content);
      if (targetLeafId !== null && !parsed.byId.has(targetLeafId)) {
        throw new Error('找不到分支節點: ' + targetLeafId);
      }
      const cursorEntry = {
        type: 'custom',
        customType: 'pi-ui:branch',
        id: genEntryId(parsed.byId),
        parentId: targetLeafId ?? null,
        timestamp: new Date().toISOString(),
      };
      appendJsonlEntries(remoteFilePath, [cursorEntry]);
      const updated = parseSessionData(fs.readFileSync(remoteFilePath, 'utf-8'));
      return { messages: updated.messages };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { remoteFilePath, targetLeafId });
    if (!res.success) return { success: false, error: res.error };
    return { success: true, messages: res.data.messages };
  }

  // 5c. 將遠端對話回溯到指定使用者訊息之前（編輯重送 / 重新生成）
  async rewindRemoteBeforeEntry(ssh, remoteFilePath, targetSpec) {
    const fnSource = `async ({ remoteFilePath, targetSpec }) => {
      ${this._remoteSessionHelperCode()}
      const content = fs.readFileSync(remoteFilePath, 'utf-8');
      const parsed = parseSessionData(content);
      const userEntry = resolveTargetUserEntry(parsed, targetSpec);
      if (!userEntry) throw new Error('找不到目標訊息節點');
      const parentLeafId = userEntry.parentId ?? null;
      const cursorEntry = {
        type: 'custom',
        customType: 'pi-ui:branch',
        id: genEntryId(parsed.byId),
        parentId: parentLeafId,
        timestamp: new Date().toISOString(),
      };
      appendJsonlEntries(remoteFilePath, [cursorEntry]);
      const updated = parseSessionData(fs.readFileSync(remoteFilePath, 'utf-8'));
      return { messages: updated.messages, rewoundToParentId: parentLeafId };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { remoteFilePath, targetSpec });
    if (!res.success) return { success: false, error: res.error };
    return { success: true, ...res.data };
  }

  // 5d. 從遠端指定使用者訊息所在回合結束處分叉出新對話檔 (Fork)
  async forkRemoteFromEntry(ssh, remoteFilePath, targetSpec) {
    const fnSource = `async ({ remoteFilePath, targetSpec }) => {
      ${this._remoteSessionHelperCode()}
      const content = fs.readFileSync(remoteFilePath, 'utf-8');
      const parsed = parseSessionData(content);
      const userEntry = resolveTargetUserEntry(parsed, targetSpec);
      if (!userEntry) throw new Error('找不到要分支的目標訊息節點');

      const { chain, header, labelsById, labelTimestampsById, isUserMessageEntry } = parsed;
      const userIdx = chain.findIndex(e => e.id === userEntry.id);
      if (userIdx === -1) throw new Error('目標訊息不在目前分支路徑上');

      let turnEndIdx = userIdx;
      for (let i = userIdx + 1; i < chain.length; i++) {
        if (isUserMessageEntry(chain[i])) break;
        if (chain[i].type === 'custom' && chain[i].customType === 'pi-ui:branch') continue;
        turnEndIdx = i;
      }

      const rawSlice = chain.slice(0, turnEndIdx + 1);
      const retainedEntries = [];
      let prevId = null;
      const usedIds = new Set();

      for (const e of rawSlice) {
        if (e.type === 'label' || (e.type === 'custom' && e.customType === 'pi-ui:branch')) {
          continue;
        }
        const cloned = { ...e, parentId: prevId };
        retainedEntries.push(cloned);
        usedIds.add(cloned.id);
        prevId = cloned.id;
      }

      const newSessionId = randomUUID();
      const iso = new Date().toISOString();
      const newHeader = {
        type: 'session',
        version: (header && header.version) || 3,
        id: newSessionId,
        timestamp: iso,
        cwd: (header && header.cwd) || process.cwd(),
        parentSession: remoteFilePath,
      };

      const labelEntries = [];
      for (const [targetId, label] of labelsById.entries()) {
        if (usedIds.has(targetId) && label) {
          const lblId = genEntryId(usedIds);
          usedIds.add(lblId);
          labelEntries.push({
            type: 'label',
            id: lblId,
            parentId: prevId,
            timestamp: labelTimestampsById.get(targetId) || iso,
            targetId,
            label,
          });
          prevId = lblId;
        }
      }

      let baseTitle = '對話';
      for (let i = parsed.entries.length - 1; i >= 0; i--) {
        const e = parsed.entries[i];
        if (e.type === 'session_info' && e.name) { baseTitle = e.name; break; }
      }
      if (baseTitle === '對話') {
        const firstU = parsed.entries.find(isUserMessageEntry);
        if (firstU) {
          baseTitle = extractText(firstU.type === 'custom_message' ? firstU.content : firstU.message?.content) || '對話';
        }
      }
      baseTitle = baseTitle.replace(/\\s+/g, ' ').trim().slice(0, 45);

      const infoEntry = {
        type: 'session_info',
        id: genEntryId(usedIds),
        parentId: prevId,
        timestamp: iso,
        name: baseTitle + ' (分支)',
      };

      const outLines = [
        JSON.stringify(newHeader),
        ...retainedEntries.map(e => JSON.stringify(e)),
        ...labelEntries.map(e => JSON.stringify(e)),
        JSON.stringify(infoEntry),
      ];

      const stamp = iso.replace(/[:.]/g, '-');
      const newPath = path.join(path.dirname(remoteFilePath), stamp + '_' + newSessionId + '.jsonl');
      fs.writeFileSync(newPath, outLines.join('\\n') + '\\n', 'utf-8');
      return { path: newPath.replace(/\\\\/g, '/') };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { remoteFilePath, targetSpec });
    if (!res.success) return { success: false, error: res.error };
    return { success: true, path: res.data.path };
  }

  // 5e. 設定或清除遠端單一訊息的書籤標籤
  async setRemoteEntryLabel(ssh, remoteFilePath, targetSpec) {
    const fnSource = `async ({ remoteFilePath, targetSpec }) => {
      ${this._remoteSessionHelperCode()}
      const content = fs.readFileSync(remoteFilePath, 'utf-8');
      const parsed = parseSessionData(content);
      const userEntry = resolveTargetUserEntry(parsed, targetSpec);
      if (!userEntry) throw new Error('找不到要標記書籤的訊息節點');
      const cleanLabel = targetSpec.label ? String(targetSpec.label).trim() : undefined;
      const labelEntry = {
        type: 'label',
        id: genEntryId(parsed.byId),
        parentId: parsed.leaf ? parsed.leaf.id : null,
        timestamp: new Date().toISOString(),
        targetId: userEntry.id,
        label: cleanLabel || undefined,
      };
      appendJsonlEntries(remoteFilePath, [labelEntry]);
      const updated = parseSessionData(fs.readFileSync(remoteFilePath, 'utf-8'));
      return { messages: updated.messages };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { remoteFilePath, targetSpec });
    if (!res.success) return { success: false, error: res.error };
    return { success: true, messages: res.data.messages };
  }

  // 5f. 切換遠端單一使用者訊息回合的 Context 略過狀態
  async toggleRemoteContextOmit(ssh, remoteFilePath, targetSpec) {
    const fnSource = `async ({ remoteFilePath, targetSpec }) => {
      ${this._remoteSessionHelperCode()}
      const content = fs.readFileSync(remoteFilePath, 'utf-8');
      const parsed = parseSessionData(content);
      const userEntry = resolveTargetUserEntry(parsed, targetSpec);
      if (!userEntry) throw new Error('找不到目標訊息節點');

      const { chain, byId, isUserMessageEntry } = parsed;
      const userIdx = chain.findIndex(e => e.id === userEntry.id);
      if (userIdx === -1) throw new Error('目標訊息不在目前分支路徑上');

      const turnEditableEntries = [];
      for (let i = userIdx; i < chain.length; i++) {
        if (i > userIdx && isUserMessageEntry(chain[i])) break;
        const e = chain[i];
        const editable =
          e.type === 'custom_message' ||
          (e.type === 'message' &&
            e.message &&
            (e.message.role === 'user' || e.message.role === 'assistant' || e.message.role === 'toolResult'));
        if (editable) turnEditableEntries.push(e);
      }

      const omit = !!targetSpec.omit;
      const iso = new Date().toISOString();
      let curParentId = parsed.leaf ? parsed.leaf.id : null;
      const newEditEntries = [];

      for (const e of turnEditableEntries) {
        const editId = genEntryId(byId);
        byId.set(editId, true);
        let replacement = null;
        if (!omit) {
          const rawContent = e.type === 'custom_message' ? e.content : e.message.content;
          const role = e.type === 'message' ? e.message.role : 'custom';
          const normalizedContent =
            (role === 'assistant' || role === 'toolResult') && typeof rawContent === 'string'
              ? [{ type: 'text', text: rawContent }]
              : rawContent;
          replacement = { content: normalizedContent };
        }
        newEditEntries.push({
          type: 'context_edit',
          id: editId,
          parentId: curParentId,
          timestamp: iso,
          targetId: e.id,
          replacement,
        });
        curParentId = editId;
      }

      appendJsonlEntries(remoteFilePath, newEditEntries);
      const updated = parseSessionData(fs.readFileSync(remoteFilePath, 'utf-8'));
      return { messages: updated.messages };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { remoteFilePath, targetSpec });
    if (!res.success) return { success: false, error: res.error };
    return { success: true, messages: res.data.messages };
  }

  // 6. 重新命名遠端對話
  async renameRemoteSession(ssh, remoteFilePath, name) {
    const fnSource = `async ({ remoteFilePath, name }) => {
      const fs = require('fs');
      const { randomBytes } = require('crypto');
      let content = fs.readFileSync(remoteFilePath, 'utf-8');
      if (!content.endsWith('\\n')) {
        fs.appendFileSync(remoteFilePath, '\\n', 'utf-8');
        content += '\\n';
      }
      const lines = content.split('\\n').filter(l => l.trim());
      let lastId = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const e = JSON.parse(lines[i]);
          if (e.id) { lastId = e.id; break; }
        } catch {}
      }
      const entry = {
        type: 'session_info',
        id: randomBytes(4).toString('hex'),
        parentId: lastId,
        timestamp: new Date().toISOString(),
        name,
      };
      fs.appendFileSync(remoteFilePath, JSON.stringify(entry) + '\\n', 'utf-8');
      return { success: true };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { remoteFilePath, name });
    if (!res.success) return { success: false, error: res.error };
    return { success: true };
  }

  // 7. 複製遠端對話
  async duplicateRemoteSession(ssh, remoteFilePath) {
    const fnSource = `async ({ remoteFilePath }) => {
      const fs = require('fs');
      const path = require('path');
      const { randomUUID } = require('crypto');
      const content = fs.readFileSync(remoteFilePath, 'utf-8');
      const newId = randomUUID();
      const iso = new Date().toISOString();
      let headerReplaced = false;
      const outLines = content.split('\\n').map((line) => {
        const t = line.trim();
        if (!t || headerReplaced) return line;
        try {
          const e = JSON.parse(t);
          if (e.type === 'session') {
            headerReplaced = true;
            e.id = newId;
            e.timestamp = iso;
            e.parentSession = remoteFilePath;
            return JSON.stringify(e);
          }
        } catch {}
        return line;
      });
      const stamp = iso.replace(/[:.]/g, '-');
      const newPath = path.join(path.dirname(remoteFilePath), stamp + '_' + newId + '.jsonl');
      fs.writeFileSync(newPath, outLines.join('\\n'), 'utf-8');
      return { path: newPath.replace(/\\\\/g, '/') };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { remoteFilePath });
    if (!res.success) return { success: false, error: res.error };
    return { success: true, path: res.data.path };
  }

  // 8. 刪除遠端對話
  async deleteRemoteSession(ssh, remoteFilePath) {
    const fnSource = `async ({ remoteFilePath }) => {
      const fs = require('fs');
      fs.rmSync(remoteFilePath, { force: true });
      return { deleted: true };
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { remoteFilePath });
    if (!res.success) return { success: false, error: res.error };
    return { success: true, trashed: false };
  }

  // 9. 匯出遠端對話至本機檔案（支援 jsonl 與 html）
  async exportRemoteSession(ssh, remoteFilePath, format, localOutputPath) {
    const fnSource = `async ({ remoteFilePath, format }) => {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const { execSync } = require('child_process');
      if (format === 'jsonl') {
        return { content: fs.readFileSync(remoteFilePath, 'utf-8') };
      }
      const tmpOut = path.join(os.tmpdir(), 'pi-export-' + Date.now() + '.html');
      try {
        execSync('pi --export ' + JSON.stringify(remoteFilePath) + ' ' + JSON.stringify(tmpOut), {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const html = fs.readFileSync(tmpOut, 'utf-8');
        try { fs.rmSync(tmpOut, { force: true }); } catch {}
        return { content: html };
      } catch (err) {
        try { fs.rmSync(tmpOut, { force: true }); } catch {}
        throw new Error('遠端匯出 HTML 失敗：' + (err.message || err));
      }
    }`;
    const res = await this.execRemoteNode(ssh, fnSource, { remoteFilePath, format }, 30000);
    if (!res.success) return { success: false, error: res.error };
    try {
      fs.writeFileSync(localOutputPath, res.data.content, 'utf-8');
      return { success: true, path: localOutputPath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

module.exports = { SshManager, quotePosix, setTracer };
