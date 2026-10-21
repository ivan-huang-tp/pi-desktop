const { contextBridge, ipcRenderer } = require('electron');

// 允許渲染層存取的受控 IPC 通道前綴白名單
const ALLOWED_PREFIXES = [
  'pi:',
  'term:',
  'ssh:',
  'fs:',
  'core:',
  'model:',
  'dialog:',
  'shell:',
  'clipboard:',
];

function isAllowedChannel(channel) {
  return (
    typeof channel === 'string' &&
    ALLOWED_PREFIXES.some((prefix) => channel.startsWith(prefix))
  );
}

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => {
    if (!isAllowedChannel(channel)) {
      throw new Error(`[Preload] Blocked invoke on unauthorized channel: ${channel}`);
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  send: (channel, ...args) => {
    if (!isAllowedChannel(channel)) {
      throw new Error(`[Preload] Blocked send on unauthorized channel: ${channel}`);
    }
    ipcRenderer.send(channel, ...args);
  },

  on: (channel, callback) => {
    if (!isAllowedChannel(channel)) {
      throw new Error(`[Preload] Blocked listener on unauthorized channel: ${channel}`);
    }
    // 不將原始 IpcRendererEvent (含 sender) 暴露給渲染層，僅傳遞資料參數
    const subscription = (_event, ...args) => callback(null, ...args);
    ipcRenderer.on(channel, subscription);
    return () => {
      ipcRenderer.removeListener(channel, subscription);
    };
  },

  removeAllListeners: (channel) => {
    if (!isAllowedChannel(channel)) return;
    ipcRenderer.removeAllListeners(channel);
  },
});
