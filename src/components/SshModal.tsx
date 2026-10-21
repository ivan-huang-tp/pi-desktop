import React, { useState, useEffect } from 'react';
import {
  Server,
  Folder,
  FolderPlus,
  CornerLeftUp,
  Home,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  X,
  Eye,
  EyeOff,
  Play,
  History,
  FolderTree,
  ArrowRight,
  Loader2,
} from 'lucide-react';
import type { SshConfig, RemoteBrowseResult, DiscoveredRemoteProject } from '../types';

interface SshModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProjectAdded: (project: { id: string; name: string; path: string; ssh: SshConfig }) => void;
}

const electron = (window as any).require ? (window as any).require('electron') : null;
const ipcRenderer = electron?.ipcRenderer;

export const SshModal: React.FC<SshModalProps> = ({
  isOpen,
  onClose,
  onProjectAdded,
}) => {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [savedHosts, setSavedHosts] = useState<SshConfig[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [browseData, setBrowseData] = useState<RemoteBrowseResult | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [activeTab, setActiveTab] = useState<'browse' | 'discovered'>('browse');

  // 新增遠端資料夾狀態
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolderLoading, setCreatingFolderLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !ipcRenderer) return;
    ipcRenderer.invoke('ssh:get-saved-hosts').then((list: SshConfig[]) => {
      if (Array.isArray(list)) {
        setSavedHosts(list);
      }
    });
  }, [isOpen]);

  if (!isOpen) return null;

  const buildCurrentSsh = (): SshConfig => {
    const p = parseInt(port, 10);
    const cleanHost = host.trim();
    return {
      id: `${cleanHost}:${Number.isFinite(p) && p > 0 ? p : 22}`,
      host: cleanHost,
      port: Number.isFinite(p) && p > 0 && p !== 22 ? p : undefined,
      password: password || undefined,
      label: cleanHost,
    };
  };

  const handleBrowse = async (targetPath = '', overrideSsh?: SshConfig) => {
    if (!ipcRenderer) {
      setError('純網頁預覽模式無法使用系統 SSH，請於 Electron 桌面版執行。');
      return;
    }
    const sshCfg = overrideSsh || buildCurrentSsh();
    if (!sshCfg.host) {
      setError('請輸入 SSH 主機位址（例如 user@192.168.1.50 或 ssh config 別名）');
      return;
    }

    setConnecting(true);
    setError(null);
    try {
      const res: RemoteBrowseResult = await ipcRenderer.invoke('ssh:browse-dir', {
        ssh: sshCfg,
        targetPath,
      });
      if (!res || !res.success) {
        setError(res?.error || 'SSH 連線失敗');
        return;
      }
      setBrowseData(res);
      setPathInput(res.currentPath || '');
    } catch (e: any) {
      setError(e?.message || 'SSH 連線異常');
    } finally {
      setConnecting(false);
    }
  };

  const handleSelectSavedHost = (h: SshConfig) => {
    setHost(h.host);
    setPort(String(h.port || 22));
    setPassword(h.password || '');
    handleBrowse('', h);
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name || !browseData?.currentPath || !ipcRenderer) return;
    const base = browseData.currentPath.replace(/\/+$/, '');
    const fullNewPath = `${base}/${name}`;

    setCreatingFolderLoading(true);
    setError(null);
    try {
      const res = await ipcRenderer.invoke('ssh:mkdir', {
        ssh: buildCurrentSsh(),
        dirPath: fullNewPath,
      });
      if (res?.success) {
        setNewFolderName('');
        setIsCreatingFolder(false);
        await handleBrowse(res.path || fullNewPath);
      } else {
        setError(res?.error || '建立資料夾失敗');
      }
    } catch (e: any) {
      setError(e?.message || '建立資料夾失敗');
    } finally {
      setCreatingFolderLoading(false);
    }
  };

  const handleConfirmOpenPath = async (remotePath: string) => {
    if (!ipcRenderer || !remotePath) return;
    const sshCfg = buildCurrentSsh();
    const cleanPath = remotePath.trim().replace(/\/+$/, '') || '/';
    const folderName = cleanPath.split('/').filter(Boolean).pop() || cleanPath;

    const saved = await ipcRenderer.invoke('ssh:save-project', {
      ssh: sshCfg,
      remotePath: cleanPath,
      name: folderName,
    });

    if (saved) {
      onProjectAdded(saved);
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[1050] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-[#2e2e34] bg-[#18181b] text-zinc-200 shadow-2xl overflow-hidden flex flex-col max-h-[88vh]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 頂部標題列 */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#27272a] bg-[#141417]">
          <div className="flex items-center space-x-2.5">
            <div className="p-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <Server size={18} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-100">新增 SSH 遠端專案</h2>
              <p className="text-xs text-zinc-400">
                直接使用系統原生 <code className="text-cyan-300 font-mono">ssh</code> 連線，支援 SSH Key 免密與密碼登入
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition"
          >
            <X size={18} />
          </button>
        </div>

        {/* 主體內容 */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {/* 曾連線過的主機快速選擇 */}
          {savedHosts.length > 0 && (
            <div>
              <div className="text-xs font-medium text-zinc-400 mb-1.5 flex items-center gap-1.5">
                <History size={12} /> 曾連線的遠端主機（點擊直接連線）：
              </div>
              <div className="flex flex-wrap gap-1.5">
                {savedHosts.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => handleSelectSavedHost(h)}
                    className={`px-2.5 py-1 rounded-md text-xs font-mono border transition flex items-center gap-1.5 ${
                      host === h.host
                        ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-200'
                        : 'bg-[#121214] border-[#2e2e34] text-zinc-300 hover:border-zinc-600'
                    }`}
                  >
                    <Server size={11} className="text-cyan-400" />
                    <span>{h.host}</span>
                    {h.port && h.port !== 22 && <span className="text-zinc-500">:{h.port}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* SSH 連線設定表單 */}
          <div className="rounded-lg border border-[#27272a] bg-[#121214] p-4 space-y-3">
            <div className="grid grid-cols-12 gap-3">
              <div className="col-span-9">
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  SSH 目標主機 (user@host 或 ~/.ssh/config 別名)
                </label>
                <input
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleBrowse(pathInput);
                  }}
                  placeholder="例如：ubuntu@192.168.1.50 或 my-linux-server"
                  className="w-full rounded-md bg-[#18181b] border border-[#323238] px-3 py-1.5 text-sm text-zinc-100 font-mono outline-none focus:border-cyan-500"
                />
              </div>
              <div className="col-span-3">
                <label className="block text-xs font-medium text-zinc-400 mb-1">Port</label>
                <input
                  type="number"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="22"
                  className="w-full rounded-md bg-[#18181b] border border-[#323238] px-3 py-1.5 text-sm text-zinc-100 font-mono outline-none focus:border-cyan-500"
                />
              </div>
            </div>

            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-zinc-400 mb-1">
                  密碼 <span className="text-zinc-500 font-normal">（選填：若已設好 SSH Key 免密登入請留空；有填則透過 SSH_ASKPASS 自動登入）</span>
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleBrowse(pathInput);
                    }}
                    placeholder="留空代表使用 SSH Key 免密登入"
                    className="w-full rounded-md bg-[#18181b] border border-[#323238] pl-3 pr-9 py-1.5 text-sm text-zinc-100 font-mono outline-none focus:border-cyan-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                    title={showPassword ? '隱藏密碼' : '顯示密碼'}
                  >
                    {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              <button
                onClick={() => handleBrowse('')}
                disabled={connecting || !host.trim()}
                className="px-4 py-1.5 h-[34px] rounded-md bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm font-medium transition flex items-center gap-1.5 shrink-0"
              >
                {connecting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    <span>連線中...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw size={14} />
                    <span>連線並瀏覽目錄</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* 錯誤提示 */}
          {error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-300 flex items-start gap-2">
              <AlertCircle size={15} className="text-red-400 shrink-0 mt-0.5" />
              <div className="break-all leading-relaxed">{error}</div>
            </div>
          )}

          {/* 連線成功：顯示環境檢測與目錄選擇器 */}
          {browseData && (
            <div className="space-y-3">
              {/* 遠端環境狀態列 */}
              <div className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs">
                <div className="flex items-center gap-2 text-emerald-300">
                  <CheckCircle2 size={15} className="text-emerald-400 shrink-0" />
                  <span>
                    已連上 <strong className="font-mono">{host.trim()}</strong>（Node {browseData.nodeVersion}）
                  </span>
                </div>
                <div className="font-mono">
                  {browseData.piAvailable ? (
                    <span className="text-emerald-300">
                      ✓ 遠端 Pi 已就緒 ({browseData.piPath})
                    </span>
                  ) : (
                    <span className="text-amber-300">
                      ⚠ 遠端 PATH 尚未偵測到 pi 指令
                    </span>
                  )}
                </div>
              </div>

              {/* 分頁切換：瀏覽遠端資料夾 vs 遠端既有 Pi 專案 */}
              <div className="flex items-center justify-between border-b border-[#27272a]">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setActiveTab('browse')}
                    className={`px-3 py-2 text-xs font-medium border-b-2 transition flex items-center gap-1.5 ${
                      activeTab === 'browse'
                        ? 'border-cyan-400 text-cyan-300'
                        : 'border-transparent text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <FolderTree size={13} />
                    <span>瀏覽遠端資料夾</span>
                  </button>
                  <button
                    onClick={() => setActiveTab('discovered')}
                    className={`px-3 py-2 text-xs font-medium border-b-2 transition flex items-center gap-1.5 ${
                      activeTab === 'discovered'
                        ? 'border-cyan-400 text-cyan-300'
                        : 'border-transparent text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <History size={13} />
                    <span>
                      遠端既有 Pi 專案 ({browseData.discoveredProjects?.length || 0})
                    </span>
                  </button>
                </div>
              </div>

              {activeTab === 'browse' ? (
                <div className="rounded-lg border border-[#27272a] bg-[#121214] overflow-hidden">
                  {/* 路徑導覽列 */}
                  <div className="p-2 border-b border-[#27272a] bg-[#151518] flex items-center gap-1.5">
                    <button
                      onClick={() => browseData.parentPath && handleBrowse(browseData.parentPath)}
                      disabled={!browseData.parentPath || connecting}
                      title="返回上一層目錄 (..)"
                      className="p-1.5 rounded hover:bg-zinc-800 disabled:opacity-40 text-zinc-300 transition"
                    >
                      <CornerLeftUp size={14} />
                    </button>
                    <button
                      onClick={() => browseData.homeDir && handleBrowse(browseData.homeDir)}
                      disabled={connecting}
                      title="前往家目錄 (~)"
                      className="p-1.5 rounded hover:bg-zinc-800 text-zinc-300 transition"
                    >
                      <Home size={14} />
                    </button>

                    <input
                      type="text"
                      value={pathInput}
                      onChange={(e) => setPathInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleBrowse(pathInput);
                      }}
                      className="flex-1 rounded bg-[#18181b] border border-[#2e2e34] px-2.5 py-1 text-xs font-mono text-zinc-100 outline-none focus:border-cyan-500"
                      placeholder="/home/user/..."
                    />

                    <button
                      onClick={() => handleBrowse(pathInput)}
                      disabled={connecting}
                      title="前往此路徑"
                      className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 transition flex items-center gap-1"
                    >
                      <span>前往</span>
                      <ArrowRight size={12} />
                    </button>

                    <button
                      onClick={() => setIsCreatingFolder((v) => !v)}
                      title="在目前目錄下新增資料夾"
                      className="p-1.5 rounded hover:bg-zinc-800 text-cyan-400 transition"
                    >
                      <FolderPlus size={14} />
                    </button>
                  </div>

                  {/* 新增資料夾輸入列 */}
                  {isCreatingFolder && (
                    <div className="px-3 py-2 bg-zinc-900/90 border-b border-[#27272a] flex items-center gap-2">
                      <FolderPlus size={14} className="text-cyan-400 shrink-0" />
                      <input
                        autoFocus
                        type="text"
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleCreateFolder();
                          if (e.key === 'Escape') setIsCreatingFolder(false);
                        }}
                        placeholder="輸入新資料夾名稱..."
                        className="flex-1 rounded bg-[#121214] border border-[#323238] px-2.5 py-1 text-xs text-zinc-100 font-mono outline-none focus:border-cyan-500"
                      />
                      <button
                        onClick={handleCreateFolder}
                        disabled={creatingFolderLoading || !newFolderName.trim()}
                        className="px-2.5 py-1 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-xs text-white transition"
                      >
                        建立
                      </button>
                      <button
                        onClick={() => setIsCreatingFolder(false)}
                        className="px-2 py-1 rounded hover:bg-zinc-800 text-xs text-zinc-400"
                      >
                        取消
                      </button>
                    </div>
                  )}

                  {/* 子目錄列表 */}
                  <div className="max-h-56 overflow-y-auto divide-y divide-[#1e1e22]">
                    {browseData.parentPath && (
                      <div
                        onClick={() => handleBrowse(browseData.parentPath!)}
                        className="px-3 py-2 flex items-center gap-2.5 text-xs text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200 cursor-pointer transition"
                      >
                        <CornerLeftUp size={14} className="text-zinc-500" />
                        <span className="font-mono">.. (返回上一層)</span>
                      </div>
                    )}

                    {(browseData.directories || []).length === 0 ? (
                      <div className="py-8 text-center text-xs text-zinc-500">
                        此目錄下沒有其他子資料夾（可直接點選下方按鈕開啟目前目錄）
                      </div>
                    ) : (
                      browseData.directories!.map((dir) => (
                        <div
                          key={dir.path}
                          onClick={() => handleBrowse(dir.path)}
                          className="px-3 py-2 flex items-center justify-between text-xs text-zinc-200 hover:bg-zinc-800/60 cursor-pointer transition group"
                        >
                          <div className="flex items-center gap-2.5 truncate">
                            <Folder size={14} className="text-amber-400/90 shrink-0" />
                            <span className="font-mono truncate">{dir.name}</span>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleConfirmOpenPath(dir.path);
                            }}
                            className="opacity-0 group-hover:opacity-100 px-2 py-0.5 rounded bg-cyan-600/20 hover:bg-cyan-600 text-cyan-300 hover:text-white border border-cyan-500/30 text-[11px] transition shrink-0"
                          >
                            選擇此目錄
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  {/* 底部確認選擇目前路徑 */}
                  <div className="px-3.5 py-2.5 bg-[#151518] border-t border-[#27272a] flex items-center justify-between gap-3">
                    <div className="text-xs text-zinc-400 truncate">
                      目前目錄：<span className="font-mono text-zinc-100">{browseData.currentPath}</span>
                    </div>
                    <button
                      onClick={() => handleConfirmOpenPath(browseData.currentPath || pathInput)}
                      className="px-3.5 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition flex items-center gap-1.5 shrink-0"
                    >
                      <Play size={12} />
                      <span>開啟目前目錄作為專案</span>
                    </button>
                  </div>
                </div>
              ) : (
                /* 遠端既有 Pi 專案清單 */
                <div className="rounded-lg border border-[#27272a] bg-[#121214] overflow-hidden max-h-72 overflow-y-auto divide-y divide-[#1e1e22]">
                  {!browseData.discoveredProjects || browseData.discoveredProjects.length === 0 ? (
                    <div className="py-10 text-center text-xs text-zinc-500">
                      這台遠端主機的 <code className="font-mono">~/.pi/agent/sessions</code> 尚無歷史對話紀錄，請切換至「瀏覽遠端資料夾」選擇專案目錄。
                    </div>
                  ) : (
                    browseData.discoveredProjects.map((dp: DiscoveredRemoteProject) => (
                      <div
                        key={dp.path}
                        className="px-3.5 py-2.5 flex items-center justify-between hover:bg-zinc-800/50 transition"
                      >
                        <div className="min-w-0 pr-3">
                          <div className="text-sm font-medium text-zinc-100 truncate flex items-center gap-2">
                            <Folder size={14} className="text-cyan-400 shrink-0" />
                            <span>{dp.name}</span>
                            <span className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">
                              {dp.sessionCount} 個對話
                            </span>
                          </div>
                          <div className="text-xs font-mono text-zinc-500 truncate mt-0.5">
                            {dp.path}
                          </div>
                        </div>
                        <button
                          onClick={() => handleConfirmOpenPath(dp.path)}
                          className="px-3 py-1 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium transition shrink-0"
                        >
                          加入並開啟
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
