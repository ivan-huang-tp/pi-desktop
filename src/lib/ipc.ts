export interface ElectronAPI {
  invoke: (channel: string, ...args: any[]) => Promise<any>;
  send: (channel: string, ...args: any[]) => void;
  on: (channel: string, callback: (_event: any, ...args: any[]) => void) => () => void;
  removeAllListeners: (channel: string) => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export interface IpcRendererCompat {
  invoke: (channel: string, ...args: any[]) => Promise<any>;
  send: (channel: string, ...args: any[]) => void;
  on: (channel: string, listener: (_event: any, ...args: any[]) => void) => () => void;
  removeListener: (channel: string, listener: (...args: any[]) => void) => void;
  removeAllListeners: (channel: string) => void;
}

// 在渲染層記錄 (channel -> Map<listener, unsubscribe>)，確保跨 contextBridge 時 removeListener 能精準解除綁定
const listenerRegistry = new Map<string, Map<Function, () => void>>();

function createIpcRenderer(): IpcRendererCompat | null {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return null;
  }

  const api = window.electronAPI;

  return {
    invoke: (channel: string, ...args: any[]) => api.invoke(channel, ...args),
    send: (channel: string, ...args: any[]) => api.send(channel, ...args),
    on: (channel: string, listener: (_event: any, ...args: any[]) => void) => {
      let channelMap = listenerRegistry.get(channel);
      if (!channelMap) {
        channelMap = new Map();
        listenerRegistry.set(channel, channelMap);
      }
      // 若同一個 listener 已註冊過，先移除舊的避免重複
      const existingUnsub = channelMap.get(listener);
      if (existingUnsub) existingUnsub();

      const unsubscribe = api.on(channel, listener);
      channelMap.set(listener, unsubscribe);
      return unsubscribe;
    },
    removeListener: (channel: string, listener: (...args: any[]) => void) => {
      const channelMap = listenerRegistry.get(channel);
      const unsubscribe = channelMap?.get(listener);
      if (unsubscribe) {
        unsubscribe();
        channelMap!.delete(listener);
      }
    },
    removeAllListeners: (channel: string) => {
      const channelMap = listenerRegistry.get(channel);
      if (channelMap) {
        for (const unsub of channelMap.values()) {
          unsub();
        }
        channelMap.clear();
      }
      api.removeAllListeners(channel);
    },
  };
}

export const ipcRenderer: IpcRendererCompat | null = createIpcRenderer();
