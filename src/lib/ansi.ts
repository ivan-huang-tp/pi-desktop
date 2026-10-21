// 移除終端機 ANSI 控制碼與還原字元，讓輸出可以直接放進 <pre> 顯示
// 涵蓋：CSI (SGR 顏色等)、OSC (設定標題等)、其他單一 ESC 序列
const OSC_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OTHER_ESC_REGEX = /\x1b[@-Z\\-_]/g;

export function stripAnsi(input: string): string {
  if (!input) return '';
  return input
    .replace(OSC_REGEX, '')
    .replace(CSI_REGEX, '')
    .replace(OTHER_ESC_REGEX, '')
    // 進度條常見的單獨 \r，統一轉成換行，避免擠在同一行
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

export function formatDuration(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}
