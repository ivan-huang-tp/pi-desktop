import React, { useState, useEffect } from 'react';
import { 
  Cpu, 
  RefreshCw, 
  DownloadCloud, 
  RotateCcw, 
  CheckCircle2, 
  AlertCircle, 
  X, 
  Terminal,
  ShieldCheck,
  FolderGit2
} from 'lucide-react';
import type { CoreInfo, CheckUpdateResult } from '../types';
import { ipcRenderer } from '../lib/ipc';

interface CoreManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  coreInfo: CoreInfo | null;
  onCoreReload?: () => void;
}

export const CoreManagerModal: React.FC<CoreManagerModalProps> = ({
  isOpen,
  onClose,
  coreInfo,
  onCoreReload,
}) => {
  const [checking, setChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<CheckUpdateResult | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateLogs, setUpdateLogs] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!ipcRenderer) return;

    const handleLog = (_event: any, log: string) => {
      setUpdateLogs((prev) => [...prev, log]);
    };

    ipcRenderer.on('core:update-log', handleLog);
    return () => {
      ipcRenderer?.removeListener('core:update-log', handleLog);
    };
  }, []);

  if (!isOpen) return null;

  const handleCheckUpdate = async () => {
    if (!ipcRenderer) {
      setStatusMessage('瀏覽器預覽模式無法執行核心更新，請於桌面版運行');
      return;
    }
    setChecking(true);
    setStatusMessage(null);
    try {
      const res: CheckUpdateResult = await ipcRenderer.invoke('core:check-update');
      setUpdateResult(res);
      if (!res.hasUpdate) {
        setStatusMessage('目前已是最新版本！');
      }
    } catch (e: any) {
      setStatusMessage(`檢查失敗: ${e.message}`);
    } finally {
      setChecking(false);
    }
  };

  const handleDoUpdate = async () => {
    if (!ipcRenderer || !updateResult?.latestVersion) return;
    setIsUpdating(true);
    setUpdateLogs([`開始下載安裝 @earendil-works/pi-coding-agent@${updateResult.latestVersion}...`]);
    setStatusMessage(null);

    try {
      const res = await ipcRenderer.invoke('core:do-update', updateResult.latestVersion);
      if (res.success) {
        setStatusMessage(`核心升級完成！已切換至 v${res.updatedVersion}`);
        await ipcRenderer.invoke('core:restart');
        if (onCoreReload) onCoreReload();
      } else {
        setStatusMessage(`升級失敗: ${res.error}`);
      }
    } catch (e: any) {
      setStatusMessage(`升級過程異常: ${e.message}`);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleResetBundled = async () => {
    if (!ipcRenderer) return;
    if (!confirm('確定要清除已下載的更新，還原至專案內建的基礎版本嗎？')) return;

    try {
      await ipcRenderer.invoke('core:reset-bundled');
      setStatusMessage('已成功還原至內建預設版本！');
      if (onCoreReload) onCoreReload();
    } catch (e: any) {
      setStatusMessage(`還原失敗: ${e.message}`);
    }
  };

  const handleRestartCore = async () => {
    if (!ipcRenderer) return;
    try {
      await ipcRenderer.invoke('core:restart');
      setStatusMessage('核心已重新啟動');
      if (onCoreReload) onCoreReload();
    } catch (e: any) {
      setStatusMessage(`重啟失敗: ${e.message}`);
    }
  };

  const getTypeBadge = (type?: string) => {
    switch (type) {
      case 'user':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-sm font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <FolderGit2 className="w-3 h-3" /> 使用者更新目錄 (User Updated)
          </span>
        );
      case 'bundled':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-sm font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <ShieldCheck className="w-3 h-3" /> 專案內建封裝版 (Bundled Base)
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-sm font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
            系統 PATH (System Global)
          </span>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[#18181b] border border-zinc-800 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
        
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-zinc-800/80 bg-zinc-900/50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
              <Cpu className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Pi 核心動態管理</h2>
              <p className="text-sm text-zinc-400">雙層動態加載機制與線上一鍵更新</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-3.5 text-sm text-zinc-300">
          {/* Current Status Card */}
          <div className="p-3.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">生效版本：</span>
              <span className="font-mono text-sm font-bold text-zinc-100">
                v{coreInfo?.version || '1.3.0'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">核心來源：</span>
              {getTypeBadge(coreInfo?.type)}
            </div>
            {coreInfo?.baseDir && (
              <div className="pt-1.5 border-t border-zinc-800/60 text-xs text-zinc-500 font-mono truncate">
                路徑: {coreInfo.baseDir}
              </div>
            )}
          </div>

          {/* Action Row */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleCheckUpdate}
              disabled={checking || isUpdating}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} />
              {checking ? '檢查中...' : '檢查 npm 最新版本'}
            </button>

            <button
              onClick={handleRestartCore}
              disabled={isUpdating}
              title="重啟本地 RPC 核心"
              className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition flex items-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              重啟
            </button>

            {coreInfo?.type === 'user' && (
              <button
                onClick={handleResetBundled}
                disabled={isUpdating}
                title="還原為內建版本"
                className="px-3 py-2 rounded-lg bg-red-900/20 hover:bg-red-900/40 border border-red-800/40 text-red-300 transition"
              >
                還原內建
              </button>
            )}
          </div>

          {/* Status Alert */}
          {statusMessage && (
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-300">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{statusMessage}</span>
            </div>
          )}

          {/* Update Available Box */}
          {updateResult?.hasUpdate && (
            <div className="p-3.5 rounded-lg bg-emerald-950/30 border border-emerald-500/30 space-y-2">
              <div className="flex items-center justify-between text-emerald-400">
                <span className="font-semibold flex items-center gap-1.5">
                  <DownloadCloud className="w-4 h-4" /> 發現新版本！
                </span>
                <span className="font-mono font-bold">v{updateResult.latestVersion}</span>
              </div>
              <p className="text-xs text-zinc-400">
                更新檔將安全下載至使用者的 AppData 目錄，完全不影響內建的基礎備份。
              </p>
              <button
                onClick={handleDoUpdate}
                disabled={isUpdating}
                className="w-full mt-1 flex items-center justify-center gap-2 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition"
              >
                <DownloadCloud className="w-3.5 h-3.5" />
                {isUpdating ? '正在下載更新...' : `立即升級至 v${updateResult.latestVersion}`}
              </button>
            </div>
          )}

          {/* Update Progress Logs */}
          {updateLogs.length > 0 && (
            <div className="rounded-lg bg-black/60 border border-zinc-800 p-2.5 space-y-1">
              <div className="flex items-center gap-1.5 text-zinc-400 text-xs">
                <Terminal className="w-3 h-3" />
                <span>升級日誌：</span>
              </div>
              <div className="font-mono text-xs text-zinc-300 max-h-28 overflow-y-auto space-y-0.5">
                {updateLogs.map((log, i) => (
                  <div key={i} className="leading-tight">{log}</div>
                ))}
              </div>
            </div>
          )}

          {/* Architecture Description */}
          <div className="text-xs text-zinc-500 leading-relaxed bg-zinc-900/30 p-2.5 rounded border border-zinc-800/40">
            <span className="text-zinc-400 font-semibold">雙層架構說明：</span>
            本桌面程式已在 <code className="text-zinc-400">resources/pi-core</code> 內建完整 Pi Agent 基礎版，即使沒有聯網或無外部 Node.js 也能即開即用；若進行升級，新版將存放在使用者專屬目錄並優先載入，隨時可一鍵無損還原。
          </div>
        </div>
      </div>
    </div>
  );
};
