// 桌面程式自身的設定（與 pi 核心的 settings.json / models.json 完全無關）
// 存放於 Electron userData 目錄，例如：
//   Windows: %APPDATA%\Pi Agent Desktop\app-settings.json
const fs = require('fs');
const path = require('path');

// 預設值：Trace 預設「關閉」（關閉時完全不寫檔、不建目錄）
// 遠端終端機預設使用 tmux（避免斷線時把遠端工作一起殺掉）
const DEFAULT_SETTINGS = {
  trace: {
    enabled: false,
    dir: 'R:\\Temp',
  },
  remoteTerminal: {
    useTmux: true,
  },
};

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }
  return value;
}

// 回傳全新的物件（不與 base 或 override 共用參考），
// 以免後續有人在記憶體裡改設定時把 DEFAULT_SETTINGS 一起改掉。
function deepMerge(base, override) {
  if (Array.isArray(base) || base === null || typeof base !== 'object') {
    if (override === undefined) return deepClone(base);
    return deepClone(override);
  }
  const out = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(override || {})]);
  for (const key of keys) {
    const b = base[key];
    const o = override ? override[key] : undefined;
    if (o === undefined) {
      out[key] = deepClone(b);
    } else if (
      o &&
      typeof o === 'object' &&
      !Array.isArray(o) &&
      b &&
      typeof b === 'object' &&
      !Array.isArray(b)
    ) {
      out[key] = deepMerge(b, o);
    } else {
      out[key] = deepClone(o);
    }
  }
  return out;
}

class AppSettings {
  constructor(app) {
    this.app = app;
    this.file = path.join(app.getPath('userData'), 'app-settings.json');
    this.data = deepMerge(DEFAULT_SETTINGS, {});
    this.listeners = new Set();
    this.loadError = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
        this.data = deepMerge(DEFAULT_SETTINGS, raw);
      }
    } catch (e) {
      this.loadError = e.message;
      console.error('[AppSettings] 讀取 app-settings.json 失敗:', e.message);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8');
      return true;
    } catch (e) {
      console.error('[AppSettings] 寫入 app-settings.json 失敗:', e.message);
      return false;
    }
  }

  get() {
    return this.data;
  }

  getSection(name) {
    return this.data[name] || {};
  }

  update(patch) {
    this.data = deepMerge(this.data, patch);
    this.save();
    for (const fn of this.listeners) {
      try {
        fn(this.data);
      } catch (e) {
        console.error('[AppSettings] 變更監聽器錯誤:', e.message);
      }
    }
    return this.data;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getFilePath() {
    return this.file;
  }
}

module.exports = { AppSettings, DEFAULT_SETTINGS };
