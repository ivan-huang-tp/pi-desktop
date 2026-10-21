// 輕量 Trace 記錄器
//
// 設計要點：
//  1. enabled=false 時「完全不碰硬碟」——不建目錄、不開檔案，所有 write 直接 return，
//     所以關閉時對速度的影響趨近於零。
//  2. 寫入是非同步且 fire-and-forget，不阻塞主程序的任何操作（尤其不拖慢 pty I/O）。
//     為避免大量 log 時把檔案描述子開爆，寫入佇列保證「同一時間最多一個開啟中的 fd」。
//  3. 單一檔案 pi-agent-desktop-trace.log，滿 8MB 輪替一次，保留 .1 ~ .4（共 5 份）。
//  4. 互動終端機（pty:out）另有每秒流量上限，避免大輸出把 trace 檔洗掉（見 logPtyOut）。
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 5;

// 機密欄位：寫檔前一律遮蔽
const SECRET_KEYS = [
  'password', 'passwd', 'secret', 'apikey', 'api_key', 'token',
  'authorization', 'auth', 'credential', 'privatekey', 'private_key',
];
const SECRET_PATTERNS = [
  /(ssh-rsa|ssh-ed25519|ecdsa-sha2)\s+[A-Za-z0-9+/=]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
];

function redactString(str) {
  let out = String(str);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '«redacted»');
  return out;
}

function redact(value, depth = 0) {
  if (depth > 6) return '«deep»';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.includes(String(k).toLowerCase().replace(/[-_]/g, ''))) {
      out[k] = v ? '«redacted»' : v;
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

// 方便把 Buffer / 長字串縮短的輔助（給 pty 與 RPC 串流用）
function truncate(str, max = 4000) {
  const s = String(str);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…«+${s.length - max} chars»`;
}

// 互動終端機輸出可能非常大量（例如 cat 一個大檔）。若全部寫入，8MB 很快就會被輪替掉，
// 反而把有用的 SSH / pi 事件沖掉。所以 pty:out 走「每秒流量預算」：
// 超過預算的內容只記錄「省略了多少 bytes」，事件順序與時間點仍然保留。
const PTY_OUT_BYTES_PER_SEC = 64 * 1024;

class Tracer {
  constructor(settings, app) {
    this.settings = settings;
    this.app = app;
    this.seq = 0;
    this.ptyWindow = null;
    this.stream = null;
    this.bytesWritten = 0;
    this.queue = [];
    this.writing = false;
    // 最近的寫入錯誤只記一次，避免錯誤風暴本身又產生大量 log
    this.lastError = null;
    this.errorCount = 0;

    settings.onChange(() => {
      // 設定變更時把目前開著的檔案關掉，下次寫入會依新設定重新開啟
      this.closeStream();
    });
  }

  get enabled() {
    return Boolean(this.settings?.getSection('trace')?.enabled);
  }

  get dir() {
    const dir = this.settings?.getSection('trace')?.dir;
    return dir && String(dir).trim() ? String(dir).trim() : 'R:\\Temp';
  }

  get filePath() {
    return path.join(this.dir, 'pi-agent-desktop-trace.log');
  }

  // 對外統一入口：tracer.log('pty:out', 'term-1', { data })
  // 關閉時只做一次 enabled 判斷就返回（不字串化、不碰檔案系統）
  log(category, message, data) {
    if (!this.enabled) return;
    this._enqueue(category, message, data);
  }

  // 記錄未經處理的物件（會自動遮蔽機密欄位）
  logJson(category, message, obj) {
    if (!this.enabled) return;
    this._enqueue(category, message, redact(obj));
  }


  // 終端機輸出專用：有每秒流量上限，避免把 trace 檔洗掉
  logPtyOut(message, data) {
    if (!this.enabled) return;
    const now = Date.now();
    if (!this.ptyWindow || now - this.ptyWindow.start >= 1000) {
      const prev = this.ptyWindow;
      if (prev && prev.dropped > 0) {
        this._enqueue('pty:out', `term=${prev.term} 省略`, {
          droppedBytes: prev.dropped,
          note: '超出每秒流量上限（事件順序仍完整保留）',
        });
      }
      this.ptyWindow = { start: now, bytes: 0, dropped: 0, term: data?.term || '?' };
    }
    const text = typeof data?.data === 'string' ? data.data : String(data?.data ?? '');
    const size = Buffer.byteLength(text, 'utf-8');
    if (this.ptyWindow.bytes + size > PTY_OUT_BYTES_PER_SEC) {
      this.ptyWindow.dropped += size;
      return;
    }
    this.ptyWindow.bytes += size;
    this._enqueue('pty:out', message, data);
  }

  _enqueue(category, message, data) {
    let line;
    try {
      line = this._format(category, message, data);
    } catch (e) {
      line = `${new Date().toISOString()} [trace] <<format error: ${e.message}>>`;
    }
    this.queue.push(line);
    // 防止極端情況（磁碟滿、R: 消失）時佇列無限成長吃掉記憶體
    if (this.queue.length > 20000) this.queue.splice(0, this.queue.length - 20000);
    this._drain();
  }

  _format(category, message, data) {
    const ts = new Date().toISOString();
    const id = String(++this.seq).padStart(6, '0');
    let line = `${ts} [#${id}] [${category}] ${message}`;
    if (data !== undefined) {
      if (typeof data === 'string') {
        line += ` | ${redactString(data)}`;
      } else {
        line += ` | ${JSON.stringify(redact(data))}`;
      }
    }
    return `${line}\n`;
  }

  _drain() {
    if (this.writing) return;
    this.writing = true;
    setImmediate(() => {
      try {
        this._flushSync();
      } catch (e) {
        this._noteError(e);
      } finally {
        this.writing = false;
        if (this.queue.length > 0) this._drain();
      }
    });
  }

  _flushSync() {
    let i = 0;
    while (i < this.queue.length) {
      if (!this.stream) {
        this._ensureStream();
        if (!this.stream) {
          // 開不起來（例如 R: 被拔掉）——丟掉這批，避免 _drain 無限重試風暴
          this.queue.length = 0;
          return;
        }
      }
      const line = this.queue[i];
      const buf = Buffer.from(line, 'utf-8');
      fs.writeSync(this.stream, buf);
      this.bytesWritten += buf.length;
      i += 1;
      // 逐行檢查而不是整批寫完才檢查，否則一次暴量（例如貼進大量輸出）
      // 會在單一檔案裡堆到遠超 MAX_BYTES 才輪替。
      if (this.bytesWritten >= MAX_BYTES) this._rotate();
    }
    this.queue.splice(0, i);
  }

  _ensureStream() {
    if (this.stream) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const target = this.filePath;
      try {
        this.bytesWritten = fs.statSync(target).size;
      } catch {
        this.bytesWritten = 0;
      }
      // 先檢查大小，避免每次啟動都把上一輪的大檔再撐爆
      if (this.bytesWritten >= MAX_BYTES) {
        this._rotateFiles(target);
        this.bytesWritten = 0;
      }
      this.stream = fs.openSync(target, 'a');
      this.lastError = null;
      // 恢復正常後歸零，這樣「再度失敗」時 UI 還會再收到一次通知
      this.errorCount = 0;
      this._writeBanner();
    } catch (e) {
      this.stream = null;
      this._noteError(e);
    }
  }

  _writeBanner() {
    const head = [
      '',
      '='.repeat(78),
      ` Pi Agent Desktop trace session  ${new Date().toISOString()}`,
      ` app=${this.app?.getVersion ? this.app.getVersion() : '?'} pid=${process.pid} platform=${process.platform}`,
      ` electron=${process.versions.electron || '?'} node=${process.versions.node || '?'}`,
      ` userData=${this.settings?.getFilePath ? path.dirname(this.settings.getFilePath()) : '?'}`,
      ` file=${this.filePath}`,
      '='.repeat(78),
      '',
    ].join('\n');
    fs.writeSync(this.stream, Buffer.from(head, 'utf-8'));
    this.bytesWritten += Buffer.byteLength(head, 'utf-8');
  }

  _rotate() {
    this.closeStream();
    this._rotateFiles(this.filePath);
    this.bytesWritten = 0;
  }

  _rotateFiles(target) {
    try {
      for (let i = MAX_FILES - 1; i >= 1; i--) {
        const from = i === 1 ? target : `${target}.${i - 1}`;
        const to = `${target}.${i}`;
        if (!fs.existsSync(from)) continue;
        // Windows 上若舊檔被編輯器/記事本開著，rename 會 EPERM。
        // 這時把舊的 .3 先刪掉再重試一次，避免整個輪替卡住。
        try {
          fs.renameSync(from, to);
        } catch {
          try {
            fs.rmSync(to, { force: true });
            fs.renameSync(from, to);
          } catch {
            /* 還是不行就算了，不讓 trace 本身害程式出錯 */
          }
        }
      }
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    } catch {
      /* ignore */
    }
  }

  closeStream() {
    if (this.stream !== null) {
      try {
        fs.closeSync(this.stream);
      } catch {
        /* ignore */
      }
      this.stream = null;
    }
  }

  _noteError(e) {
    this.errorCount += 1;
    // 同一個錯誤只印一次，之後只累加次數
    if (this.lastError !== e.message) {
      this.lastError = e.message;
      console.error(`[Tracer] 無法寫入 trace 檔 (${this.filePath}): ${e.message}`);
    }
    if (this.errorCount === 1) {
      // 第一次失敗時把訊息送到 renderer，UI 才有辦法提示使用者
      try {
        this.settings?.onTraceError?.(e.message);
      } catch {
        /* ignore */
      }
    }
  }

  // 讓使用者按「測試寫入」時可以拿到明確結果
  testWrite() {
    const dir = this.dir;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.pi-ui-trace-probe');
      fs.writeFileSync(probe, `probe ${new Date().toISOString()}\n`, 'utf-8');
      fs.rmSync(probe, { force: true });
      this.lastError = null;
      this.errorCount = 0;
      this.log('trace', '使用者手動測試寫入成功');
      return { success: true, file: this.filePath };
    } catch (e) {
      return { success: false, error: e.message, dir: this.dir };
    }
  }

  writeMarker(text) {
    this.log('marker', text);
  }

  getStats() {
    return {
      enabled: this.enabled,
      dir: this.dir,
      file: this.filePath,
      bytesWritten: this.bytesWritten,
      queued: this.queue.length,
      lastError: this.lastError,
      errorCount: this.errorCount,
    };
  }
}

module.exports = { Tracer, redact, truncate };
