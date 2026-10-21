// 使用者互動式終端機管理（node-pty），類似 VS Code 的整合式終端機
const fs = require('fs');
const os = require('os');
const path = require('path');
const { quotePosix } = require('./ssh-manager.cjs');
const { truncate } = require('./tracer.cjs');

let pty = null;
let ptyLoadError = null;
let ptyLoaded = false;

// 延遲載入 node-pty：App 啟動時完全不碰 C++ 原生模組，只有真正打開終端機時才載入
function ensurePty() {
  if (ptyLoaded) return pty;
  ptyLoaded = true;
  try {
    pty = require('node-pty');
  } catch (e) {
    ptyLoadError = e;
    console.error('[TerminalManager] node-pty 載入失敗:', e);
  }
  return pty;
}

const exists = (p) => {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
};

// 由遠端工作目錄推導出穩定、可重複 attach 的 tmux session 名稱
// 同名 = 同一個持久終端 → 斷線/關面板/重開 App 後 attach 回來畫面還在
function tmuxSessionName(remoteDir) {
  const raw = String(remoteDir || '~').replace(/\/+$/, '');
  // 依序退到最後一段目錄名；'~' 或空字串算 home
  const base =
    raw === '~' || raw === ''
      ? 'home'
      : raw.split('/').filter(Boolean).pop() || 'home';
  const safe = base.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'home';
  return `piui-${safe}`;
}

// 在 PATH 中尋找執行檔（快顯暫存）
const whichCache = new Map();
const which = (exe) => {
  if (whichCache.has(exe)) return whichCache.get(exe);
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const full = path.join(d, exe);
    if (exists(full)) {
      whichCache.set(exe, full);
      return full;
    }
  }
  whichCache.set(exe, null);
  return null;
};

// 偵測系統上可用的 shell
function detectShells() {
  const shells = [];
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA || '';

    // 優先檢查常見固定路徑（免去掃描整個 PATH，大幅提升速度）
    const pwshCandidates = [
      path.join(progFiles, 'PowerShell', '7', 'pwsh.exe'),
      path.join(progFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
      localAppData ? path.join(localAppData, 'Microsoft', 'PowerShell', '7', 'pwsh.exe') : null,
    ].filter(Boolean);
    const pwsh = pwshCandidates.find(exists) || which('pwsh.exe');
    if (pwsh) shells.push({ id: 'pwsh', name: 'PowerShell 7', path: pwsh, args: ['-NoLogo'] });

    const winPs = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    shells.push({
      id: 'powershell',
      name: 'Windows PowerShell',
      path: exists(winPs) ? winPs : 'powershell.exe',
      args: ['-NoLogo'],
    });
    shells.push({ id: 'cmd', name: 'Command Prompt', path: process.env.ComSpec || 'cmd.exe', args: [] });

    const gitBashCandidates = [
      path.join(progFiles, 'Git', 'bin', 'bash.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      localAppData ? path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe') : null,
    ].filter(Boolean);
    let gitBash = gitBashCandidates.find(exists);
    if (!gitBash) {
      const gitFromPath = which('git.exe');
      if (gitFromPath) {
        const candidate = path.join(path.dirname(gitFromPath), '..', 'bin', 'bash.exe');
        if (exists(candidate)) gitBash = candidate;
      }
    }
    if (gitBash) shells.push({ id: 'gitbash', name: 'Git Bash', path: path.resolve(gitBash), args: ['--login', '-i'] });
  } else {
    const userShell = process.env.SHELL || '/bin/bash';
    shells.push({ id: 'default', name: path.basename(userShell), path: userShell, args: ['-l'] });
    for (const s of ['/bin/bash', '/bin/zsh', '/usr/bin/fish']) {
      if (s !== userShell && exists(s)) shells.push({ id: path.basename(s), name: path.basename(s), path: s, args: ['-l'] });
    }
  }
  return shells;
}

class TerminalManager {
  constructor(getWindow, getSshManager, tracer, appSettings) {
    this.getWindow = getWindow;
    this.getSshManager = getSshManager;
    this.tracer = tracer || null;
    this.appSettings = appSettings || null;
    this.terms = new Map(); // id -> pty
    this.seq = 0;
    this.shells = null;
  }

  // 集中管理 trace（tracer 未啟用時僅是一次布林判斷）
  trace(category, message, data) {
    if (this.tracer) this.tracer.log(category, message, data);
  }

  tracePtyOut(message, data) {
    if (this.tracer) this.tracer.logPtyOut(message, data);
  }

  send(channel, payload) {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  listShells() {
    ensurePty();
    if (!this.shells) this.shells = detectShells();
    return {
      available: !!pty,
      error: ptyLoadError ? String(ptyLoadError.message || ptyLoadError) : undefined,
      shells: this.shells.map(({ id, name }) => ({ id, name })),
    };
  }

  create({ shellId, cwd, cols, rows, ssh } = {}) {
    const ptyLib = ensurePty();
    if (!ptyLib) {
      this.trace('term:create', 'node-pty 無法載入', { error: String(ptyLoadError?.message || ptyLoadError) });
      return { success: false, error: `node-pty 無法載入：${ptyLoadError?.message || 'unknown'}` };
    }

    // 若為 SSH 遠端專案且未強制指定本機 shellId，直接開啟遠端 SSH 互動式終端機
    if (ssh && ssh.host && !shellId) {
      try {
        const sshMgr = this.getSshManager ? this.getSshManager() : null;
        const normSsh = sshMgr ? sshMgr.normalizeSshConfig(ssh) : ssh;
        const sshExe = process.platform === 'win32' ? (which('ssh.exe') || 'ssh.exe') : 'ssh';
        const remoteDir = cwd || '~';
        const cdPart =
          remoteDir === '~' || remoteDir === ''
            ? 'cd "$HOME"'
            : `cd ${quotePosix(remoteDir)}`;

        // 預設用 tmux 包住互動 shell：
        // ssh 通道斷掉時，遠端 pty 被摧毀 → kernel 會送 SIGHUP 給 session 前景程序群組，
        // 把使用者正在跑的長工作一併殺掉。用 tmux 當 session 邊界就沒這問題。
        const useTmux = this.appSettings?.getSection('remoteTerminal')?.useTmux !== false;
        const tmuxName = tmuxSessionName(remoteDir);
        const shellExec = 'exec \${SHELL:-/bin/bash} -l';
        const remoteCmd = useTmux
          ? `if command -v tmux >/dev/null 2>&1; then ${cdPart} 2>/dev/null || true; ` +
            `exec tmux new-session -A -s ${quotePosix(tmuxName)}; fi; ` +
            `${cdPart} 2>/dev/null || true; ${shellExec}`
          : `${cdPart} 2>/dev/null || true; ${shellExec}`;

        const sshArgs = [
          '-t',
          '-o', 'StrictHostKeyChecking=accept-new',
          '-o', 'ServerAliveInterval=15',
          '-o', 'ServerAliveCountMax=3',
        ];
        if (normSsh.port && normSsh.port !== 22) {
          sshArgs.push('-p', String(normSsh.port));
        }
        sshArgs.push(...String(normSsh.host).split(/\s+/).filter(Boolean), remoteCmd);

        const env = sshMgr
          ? sshMgr.buildSshEnv(normSsh)
          : { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };

        this.trace('term:create', '開啟 SSH 終端機', {
          host: normSsh.host,
          port: normSsh.port || 22,
          remoteDir,
          tmux: useTmux ? tmuxName : '(未使用)',
          cols,
          rows,
        });

        const proc = ptyLib.spawn(sshExe, sshArgs, {
          name: 'xterm-256color',
          cols: Math.max(2, cols || 80),
          rows: Math.max(2, rows || 24),
          cwd: os.homedir(),
          env,
          useConpty: true,
        });
        const id = `term-${++this.seq}`;
        this.terms.set(id, proc);
        proc.onData((data) => {
          this.tracePtyOut(`term=${id} ssh=${normSsh.host}`, { term: id, data: truncate(data, 4000) });
          this.send('term:data', { id, data });
        });
        proc.onExit(({ exitCode }) => {
          this.trace('pty:exit', `term=${id} ssh=${normSsh.host}`, { exitCode });
          this.terms.delete(id);
          this.send('term:exit', { id, exitCode });
        });
        const shellName = useTmux ? `SSH: ${normSsh.host} (tmux)` : `SSH: ${normSsh.host}`;
        return { success: true, id, shellId: 'ssh', shellName, cwd: remoteDir, tmux: useTmux ? tmuxName : null };
      } catch (e) {
        this.trace('term:create', 'SSH 終端機建立失敗', { error: e.message });
        return { success: false, error: e.message };
      }
    }

    if (!this.shells) this.shells = detectShells();
    const shell = this.shells.find((s) => s.id === shellId) || this.shells[0];
    const workDir = exists(cwd) ? cwd : os.homedir();
    try {
      const proc = ptyLib.spawn(shell.path, shell.args, {
        name: 'xterm-256color',
        cols: Math.max(2, cols || 80),
        rows: Math.max(2, rows || 24),
        cwd: workDir,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        useConpty: true,
      });
      const id = `term-${++this.seq}`;
      this.terms.set(id, proc);
      this.trace('term:create', '開啟本機終端機', { shell: shell.id, shellPath: shell.path, workDir, cols, rows });
      proc.onData((data) => {
        this.tracePtyOut(`term=${id} shell=${shell.id}`, { term: id, data: truncate(data, 4000) });
        this.send('term:data', { id, data });
      });
      proc.onExit(({ exitCode }) => {
        this.trace('pty:exit', `term=${id} shell=${shell.id}`, { exitCode });
        this.terms.delete(id);
        this.send('term:exit', { id, exitCode });
      });
      return { success: true, id, shellId: shell.id, shellName: shell.name, cwd: workDir };
    } catch (e) {
      this.trace('term:create', '本機終端機建立失敗', { shell: shell?.id, error: e.message });
      return { success: false, error: e.message };
    }
  }

  write(id, data) {
    this.trace('pty:in', `term=${id}`, { data: truncate(data, 2000) });
    this.terms.get(id)?.write(data);
  }

  resize(id, cols, rows) {
    const t = this.terms.get(id);
    if (!t || !cols || !rows) return;
    try {
      t.resize(Math.max(2, cols), Math.max(2, rows));
    } catch {
      /* 程序可能已結束 */
    }
  }

  kill(id) {
    const t = this.terms.get(id);
    if (!t) return;
    this.terms.delete(id);
    this.trace('term:kill', `term=${id}`);
    try {
      t.kill();
    } catch {
      /* ignore */
    }
  }

  killAll() {
    if (this.terms.size > 0) this.trace('term:kill-all', '關閉所有終端機', { count: this.terms.size });
    for (const id of [...this.terms.keys()]) this.kill(id);
  }
}

module.exports = { TerminalManager };
