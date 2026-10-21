// 使用者互動式終端機管理（node-pty），類似 VS Code 的整合式終端機
const fs = require('fs');
const os = require('os');
const path = require('path');

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
  constructor(getWindow) {
    this.getWindow = getWindow;
    this.terms = new Map(); // id -> pty
    this.seq = 0;
    this.shells = null;
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

  create({ shellId, cwd, cols, rows } = {}) {
    const ptyLib = ensurePty();
    if (!ptyLib) return { success: false, error: `node-pty 無法載入：${ptyLoadError?.message || 'unknown'}` };
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
      proc.onData((data) => this.send('term:data', { id, data }));
      proc.onExit(({ exitCode }) => {
        this.terms.delete(id);
        this.send('term:exit', { id, exitCode });
      });
      return { success: true, id, shellId: shell.id, shellName: shell.name, cwd: workDir };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  write(id, data) {
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
    try {
      t.kill();
    } catch {
      /* ignore */
    }
  }

  killAll() {
    for (const id of [...this.terms.keys()]) this.kill(id);
  }
}

module.exports = { TerminalManager };
