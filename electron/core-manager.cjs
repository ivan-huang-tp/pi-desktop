const path = require('path');
const fs = require('fs');
const https = require('https');
const { exec, spawn } = require('child_process');

class CoreManager {
  constructor(app, tracer) {
    this.app = app;
    this.tracer = tracer || null;
    this.packageName = '@earendil-works/pi-coding-agent';
  }

  trace(category, message, data) {
    if (this.tracer) this.tracer.log(category, message, data);
  }

  // 取得使用者更新目錄
  getUserCoreDir() {
    const userDataPath = this.app ? this.app.getPath('userData') : path.join(process.env.APPDATA || process.env.HOME || '.', '.pi-ui');
    return path.join(userDataPath, 'pi-core');
  }

  // 取得專案內建核心目錄
  getBundledCoreDir() {
    // 檢查 Electron 打包後的 resourcesPath
    if (process.resourcesPath) {
      const prodPath = path.join(process.resourcesPath, 'pi-core');
      if (fs.existsSync(prodPath)) return prodPath;
    }
    // 開發環境路徑
    const devPath = path.join(__dirname, '../resources/pi-core');
    if (fs.existsSync(devPath)) return devPath;

    return null;
  }

  // 解析當前優先使用的核心
  resolveCore() {
    const core = this._resolveCore();
    this.trace('core:resolve', '解析核心', {
      type: core.type,
      version: core.version,
      baseDir: core.baseDir,
    });
    return core;
  }

  _resolveCore() {
    const userDir = this.getUserCoreDir();
    
    // 1. 檢查使用者更新目錄（自訂安裝的最新版本）
    // 可能結構：userDir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js 或直接在 userDir/dist/bundle/cli.js
    const candidatePaths = [
      path.join(userDir, 'node_modules', '@earendil-works', 'pi-coding-agent'),
      userDir,
    ];

    for (const cand of candidatePaths) {
      const cliPath = path.join(cand, 'dist', 'bundle', 'cli.js');
      const pkgPath = path.join(cand, 'package.json');
      if (fs.existsSync(cliPath) && fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          return {
            type: 'user',
            version: pkg.version || 'unknown',
            cliPath,
            baseDir: cand,
            description: '使用者目錄已更新核心 (User Updated)',
          };
        } catch (e) {}
      }
    }

    // 2. 檢查內建打包核心
    const bundledDir = this.getBundledCoreDir();
    if (bundledDir) {
      const bundledCli = path.join(bundledDir, 'dist', 'bundle', 'cli.js');
      const bundledPkg = path.join(bundledDir, 'package.json');
      if (fs.existsSync(bundledCli)) {
        let version = '1.3.0';
        try {
          if (fs.existsSync(bundledPkg)) {
            const pkg = JSON.parse(fs.readFileSync(bundledPkg, 'utf-8'));
            version = pkg.version || version;
          }
        } catch (e) {}

        return {
          type: 'bundled',
          version,
          cliPath: bundledCli,
          baseDir: bundledDir,
          description: '專案內建基礎核心 (Bundled)',
        };
      }
    }

    // 3. Fallback: 系統全域 pi 指令
    return {
      type: 'system',
      version: 'system',
      cliPath: null,
      command: 'pi',
      baseDir: null,
      description: '系統全域 PATH (System Global)',
    };
  }

  // 檢查 npm registry 最新版本
  async checkForUpdates() {
    const current = this.resolveCore();
    return new Promise((resolve, reject) => {
      const url = `https://registry.npmjs.org/${encodeURIComponent(this.packageName)}/latest`;
      const req = https.get(url, { headers: { 'User-Agent': 'Pi-UI-Updater' } }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              return resolve({
                success: false,
                currentVersion: current.version,
                error: `HTTP ${res.statusCode}`,
              });
            }
            const info = JSON.parse(data);
            const latestVersion = info.version;
            const hasUpdate = this.compareVersions(latestVersion, current.version) > 0;

            resolve({
              success: true,
              currentType: current.type,
              currentVersion: current.version,
              latestVersion,
              hasUpdate,
              tarball: info.dist?.tarball,
              description: current.description,
            });
          } catch (err) {
            resolve({ success: false, currentVersion: current.version, error: err.message });
          }
        });
      });

      req.on('error', (err) => {
        resolve({ success: false, currentVersion: current.version, error: err.message });
      });
      req.setTimeout(8000, () => {
        req.destroy();
        resolve({ success: false, currentVersion: current.version, error: '連線逾時' });
      });
    });
  }

  // 比對版本號 semver 簡化比較 (v1 > v2 => 1, v1 == v2 => 0, v1 < v2 => -1)
  compareVersions(v1, v2) {
    if (!v1 || !v2) return 0;
    if (v2 === 'system') return 1;
    const p1 = v1.replace(/^v/, '').split('.').map(Number);
    const p2 = v2.replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const n1 = p1[i] || 0;
      const n2 = p2[i] || 0;
      if (n1 > n2) return 1;
      if (n1 < n2) return -1;
    }
    return 0;
  }

  // 執行安裝更新到使用者資料夾
  async installUpdate(targetVersion = 'latest', logCallback = () => {}) {
    const userDir = this.getUserCoreDir();
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    logCallback(`[更新管理] 準備更新核心至版本: ${targetVersion}`);
    logCallback(`[更新管理] 安裝目標目錄: ${userDir}`);
    this.trace('core:update', '開始更新核心', { targetVersion, userDir });

    return new Promise((resolve, reject) => {
      // 優先使用 npm install
      const cmd = `npm install --prefix "${userDir}" ${this.packageName}@${targetVersion} --omit=dev --no-audit --no-fund`;
      logCallback(`[更新管理] 執行: ${cmd}`);

      const child = exec(cmd, { cwd: userDir, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          logCallback(`[更新管理] npm 安裝失敗: ${error.message}`);
          return resolve({ success: false, error: error.message });
        }
        logCallback(`[更新管理] 核心升級成功！`);
        const updated = this.resolveCore();
        resolve({ success: true, updatedVersion: updated.version });
      });

      if (child.stdout) {
        child.stdout.on('data', (d) => logCallback(d.toString().trim()));
      }
      if (child.stderr) {
        child.stderr.on('data', (d) => logCallback(d.toString().trim()));
      }
    });
  }

  // 重設還原至內建版本
  resetToBundled() {
    const userDir = this.getUserCoreDir();
    this.trace('core:reset', '還原為內建核心', { userDir });
    if (fs.existsSync(userDir)) {
      try {
        fs.rmSync(userDir, { recursive: true, force: true });
      } catch (e) {
        console.error('移除使用者目錄失敗:', e);
        return false;
      }
    }
    return true;
  }
}

module.exports = { CoreManager };
