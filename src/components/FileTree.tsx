import React, { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { Tree, NodeRendererProps, TreeApi } from 'react-arborist';
import {
  Folder,
  FolderOpen as FolderOpenIcon,
  FileCode,
  FileText,
  File,
  Image as ImageIcon,
  RefreshCw,
  ArrowUp,
  Eye,
  EyeOff,
  Save,
  Copy,
  Scissors,
  ClipboardPaste,
  Check,
  FolderOpen,
  WrapText,
  Code,
  BookOpen,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Home,
  Undo2,
  Redo2,
  Loader2,
  AlertCircle,
  Pencil,
  Trash2,
  FilePlus,
  FolderPlus,
  Copy as CopyPathIcon,
  AlertTriangle,
} from 'lucide-react';
import { Markdown } from './Markdown';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import type { MonacoCodeEditorHandle } from './MonacoCodeEditor';
import type { FileItem, SshConfig, DirectoryReadResult, FileReadResult } from '../types';

// 動態延遲載入 Monaco Editor，唯有打開文字/程式碼檔案時才載入，確保啟動秒開
const MonacoCodeEditor = lazy(() =>
  import('./MonacoCodeEditor').then((m) => ({ default: m.MonacoCodeEditor }))
);

import { ipcRenderer } from '../lib/ipc';

const SHOW_HIDDEN_STORAGE_KEY = 'pi-ui:files-show-hidden';
const WORD_WRAP_STORAGE_KEY = 'pi-ui:editor-word-wrap';

interface ArboristFileNode extends FileItem {
  id: string;
  isParentLink?: boolean;
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 100 ? 0 : 2)} MB`;
}

function isMarkdownFile(name: string): boolean {
  const lower = (name || '').toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.markdown');
}

function isImageFileName(name: string): boolean {
  const lower = (name || '').toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif'].some((ext) =>
    lower.endsWith(ext)
  );
}

export function getFileIcon(fileName: string) {
  const lower = fileName.toLowerCase();
  if (isImageFileName(lower)) {
    return <ImageIcon size={14} className="text-pink-400 shrink-0" />;
  }
  if (
    lower.endsWith('.tsx') ||
    lower.endsWith('.ts') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.js') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs') ||
    lower.endsWith('.py') ||
    lower.endsWith('.rs') ||
    lower.endsWith('.go')
  ) {
    return <FileCode size={14} className="text-blue-400 shrink-0" />;
  }
  if (lower.endsWith('.json') || lower.endsWith('.md') || lower.endsWith('.yml') || lower.endsWith('.yaml')) {
    return <FileText size={14} className="text-amber-400 shrink-0" />;
  }
  if (lower.endsWith('.css') || lower.endsWith('.scss') || lower.endsWith('.html')) {
    return <FileCode size={14} className="text-emerald-400 shrink-0" />;
  }
  return <File size={14} className="text-zinc-400 shrink-0" />;
}

interface FileTreeProps {
  files?: FileItem[];
  currentWorkspace: string;
  ssh?: SshConfig;
  refreshTrigger?: number;
  onRefresh?: () => void;
  revealRequest?: { path: string; nonce: number } | null;
}

export const FileTree: React.FC<FileTreeProps> = ({
  currentWorkspace,
  ssh,
  refreshTrigger = 0,
  revealRequest,
}) => {
  // 1. 目錄瀏覽狀態
  const [currentDir, setCurrentDir] = useState<string>(currentWorkspace);
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [items, setItems] = useState<FileItem[]>([]);
  const [dirLoading, setDirLoading] = useState<boolean>(false);
  const [dirError, setDirError] = useState<string | null>(null);

  // 路徑列點擊手動輸入跳轉
  const [isEditingPath, setIsEditingPath] = useState<boolean>(false);
  const [pathInput, setPathInput] = useState<string>(currentWorkspace);

  // 顯示隱藏檔開關（預設為 true：顯示所有 . 開頭隱藏檔）
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(SHOW_HIDDEN_STORAGE_KEY);
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });

  // 2. 檔案操作狀態（剪貼簿、內嵌新增、刪除確認、右鍵選單、底部提示）
  const [fileClipboard, setFileClipboard] = useState<{
    paths: string[];
    mode: 'copy' | 'cut';
    sshId?: string;
  } | null>(null);
  const [creatingItem, setCreatingItem] = useState<{ isDirectory: boolean; value: string } | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<ArboristFileNode[] | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  const [opToast, setOpToast] = useState<string | null>(null);
  const opToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showOpToast = useCallback((msg: string) => {
    setOpToast(msg);
    if (opToastTimerRef.current) clearTimeout(opToastTimerRef.current);
    opToastTimerRef.current = setTimeout(() => setOpToast(null), 2400);
  }, []);

  // 3. 檔案檢視 / 編輯器狀態（滿版切換）
  const [activeFile, setActiveFile] = useState<FileReadResult | null>(null);
  const [fileLoading, setFileLoading] = useState<boolean>(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  // 檢視模式：'preview' (用於 Markdown / SVG 預覽) | 'code' (Monaco 編輯器)
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('code');
  const [wordWrap, setWordWrap] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(WORD_WRAP_STORAGE_KEY);
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });

  // 圖片縮放與尺寸資訊
  const [imageZoom, setImageZoom] = useState<number>(100);
  const [imageDimensions, setImageDimensions] = useState<{ w: number; h: number } | null>(null);

  // react-arborist 參照與容器尺寸量測
  const treeRef = useRef<TreeApi<ArboristFileNode> | null>(null);
  const treeContainerRef = useRef<HTMLDivElement | null>(null);
  const [treeSize, setTreeSize] = useState<{ width: number; height: number }>({ width: 360, height: 500 });

  const currentDirRef = useRef(currentDir);
  currentDirRef.current = currentDir;
  const monacoEditorRef = useRef<MonacoCodeEditorHandle | null>(null);

  // 動態監聽列表容器寬高供 react-arborist 虛擬列表渲染
  useEffect(() => {
    const el = treeContainerRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setTreeSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
      }
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeFile, fileLoading, creatingItem]);

  const toggleShowHidden = () => {
    setShowHidden((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SHOW_HIDDEN_STORAGE_KEY, String(next));
      } catch {}
      return next;
    });
  };

  const toggleWordWrap = () => {
    setWordWrap((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(WORD_WRAP_STORAGE_KEY, String(next));
      } catch {}
      return next;
    });
  };

  // 讀取指定目錄（支援本機與 SSH 遠端）
  const loadDirectory = useCallback(
    async (targetPath: string) => {
      if (!ipcRenderer) return;
      setDirLoading(true);
      setDirError(null);
      try {
        const res: DirectoryReadResult | FileItem[] = await ipcRenderer.invoke(
          'fs:read-directory',
          ssh ? { dirPath: targetPath, ssh } : targetPath
        );

        if (Array.isArray(res)) {
          setCurrentDir(targetPath);
          setPathInput(targetPath);
          setParentDir(null);
          setItems(res);
        } else if (res && typeof res === 'object') {
          if (!res.success && res.error) {
            setDirError(res.error);
          }
          const resolvedDir = res.currentPath || targetPath;
          setCurrentDir(resolvedDir);
          setPathInput(resolvedDir);
          setParentDir(res.parentPath ?? null);
          setItems(Array.isArray(res.items) ? res.items : []);
        }
      } catch (e: any) {
        setDirError(e?.message || '讀取目錄失敗');
      } finally {
        setDirLoading(false);
      }
    },
    [ssh]
  );

  // 當切換工作區或 SSH 主機時，重設目錄至新的工作區根目錄並關閉開啟中的檔案
  useEffect(() => {
    setActiveFile(null);
    setFileError(null);
    setCreatingItem(null);
    setCurrentDir(currentWorkspace);
    setPathInput(currentWorkspace);
    loadDirectory(currentWorkspace);
  }, [currentWorkspace, ssh?.id, loadDirectory]);

  // 當外部（例如 Pi 工具執行完畢）觸發重整時，刷新目前所在的目錄
  useEffect(() => {
    if (refreshTrigger > 0) {
      loadDirectory(currentDirRef.current);
    }
  }, [refreshTrigger, loadDirectory]);

  // 開啟檔案（滿版切換）
  const openFile = useCallback(
    async (filePath: string, fileName: string) => {
      if (!ipcRenderer) return;
      setFileLoading(true);
      setFileError(null);
      setImageZoom(100);
      setImageDimensions(null);
      setActiveFile({
        success: true,
        filePath,
        name: fileName,
        kind: 'text',
        content: '',
        size: 0,
      });

      try {
        const res: FileReadResult = await ipcRenderer.invoke(
          'fs:read-file',
          ssh ? { filePath, ssh } : filePath
        );
        if (!res || !res.success) {
          setFileError(res?.error || '無法讀取檔案');
          return;
        }
        setActiveFile(res);
        setEditedContent(res.content ?? '');

        if (res.kind === 'image') {
          setViewMode('preview');
        } else if (isMarkdownFile(res.name)) {
          setViewMode('preview');
        } else {
          setViewMode('code');
        }
      } catch (e: any) {
        setFileError(e?.message || '讀取檔案失敗');
      } finally {
        setFileLoading(false);
      }
    },
    [ssh]
  );

  // 解析來自對話區點擊的相對/絕對路徑，並在右側開啟檔案或切換至該目錄
  useEffect(() => {
    if (!revealRequest || !revealRequest.path || !ipcRenderer) return;

    const raw = revealRequest.path
      .trim()
      .replace(/#L\d+(?:-L?\d+)?$/i, '')
      .replace(/:\d+(?::\d+)?(?=-\d+|\b).*$/, '');
    if (!raw) return;

    const isExplicitDir = /[\\/]$/.test(raw);
    const usePosix = Boolean(ssh) || currentWorkspace.includes('/');
    const sep = usePosix ? '/' : '\\';

    // 判斷是否為絕對路徑（Windows 磁碟機開頭或 Unix / 開頭）
    const isAbs = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/');
    let resolvedPath = raw;
    if (!isAbs) {
      const cleanRel = raw.replace(/^\.[\\/]/, '');
      const base = currentWorkspace.replace(/[\\/]+$/, '');
      resolvedPath = `${base}${sep}${cleanRel}`;
    }
    // 統一斜線方向（保留結尾斜線判斷後去除多餘斜線）
    resolvedPath = usePosix
      ? resolvedPath.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
      : resolvedPath.replace(/\//g, '\\').replace(/\\+$/, '');

    if (isExplicitDir) {
      setActiveFile(null);
      setFileError(null);
      loadDirectory(resolvedPath);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res: FileReadResult = await ipcRenderer.invoke(
          'fs:read-file',
          ssh ? { filePath: resolvedPath, ssh } : resolvedPath
        );
        if (cancelled) return;

        // 若目標實際上是資料夾，直接切換檔案樹至該資料夾
        if (!res?.success && res?.error && res.error.includes('資料夾')) {
          setActiveFile(null);
          setFileError(null);
          loadDirectory(resolvedPath);
          return;
        }

        if (!res || !res.success) {
          showOpToast(res?.error || `找不到路徑：${raw}`);
          return;
        }

        // 同步將背景的檔案樹目錄切到該檔案所在的父目錄，讓「↑」按鈕能返回該檔案所在資料夾
        const lastSep = Math.max(res.filePath.lastIndexOf('/'), res.filePath.lastIndexOf('\\'));
        if (lastSep > 0) {
          const parentPath = res.filePath.slice(0, lastSep);
          loadDirectory(parentPath);
        }

        setFileError(null);
        setImageZoom(100);
        setImageDimensions(null);
        setActiveFile(res);
        setEditedContent(res.content ?? '');

        if (res.kind === 'image') {
          setViewMode('preview');
        } else if (isMarkdownFile(res.name)) {
          setViewMode('preview');
        } else {
          setViewMode('code');
        }
      } catch (e: any) {
        if (!cancelled) {
          showOpToast(e?.message || `無法開啟：${raw}`);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [revealRequest, currentWorkspace, ssh, loadDirectory, showOpToast]);

  // 儲存檔案（支援本機與 SSH 遠端）
  const isDirty =
    activeFile !== null &&
    activeFile.content !== undefined &&
    !activeFile.truncated &&
    editedContent !== activeFile.content;

  const handleSaveFile = useCallback(async () => {
    if (!ipcRenderer || !activeFile || activeFile.content === undefined || activeFile.truncated) {
      return;
    }
    setSaving(true);
    try {
      const res = await ipcRenderer.invoke('fs:write-file', {
        filePath: activeFile.filePath,
        content: editedContent,
        ssh,
      });
      if (res?.success) {
        setActiveFile((prev) =>
          prev
            ? {
                ...prev,
                content: editedContent,
                size: typeof res.size === 'number' ? res.size : prev.size,
              }
            : null
        );
        setSaveToast('已儲存');
        setTimeout(() => setSaveToast(null), 1800);
      } else {
        setSaveToast(`儲存失敗: ${res?.error || '未知錯誤'}`);
        setTimeout(() => setSaveToast(null), 3000);
      }
    } catch (e: any) {
      setSaveToast(`儲存失敗: ${e?.message || '未知錯誤'}`);
      setTimeout(() => setSaveToast(null), 3000);
    } finally {
      setSaving(false);
    }
  }, [activeFile, editedContent, ssh]);

  // 即使焦點不在 Monaco 內部，按 Ctrl+S / Cmd+S 也能儲存檔案
  useEffect(() => {
    if (!activeFile) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSaveFile();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeFile, handleSaveFile]);

  const handleCopyContent = async () => {
    if (!activeFile) return;
    const textToCopy = editedContent || activeFile.filePath;
    if (ipcRenderer) {
      await ipcRenderer.invoke('clipboard:write', textToCopy);
    } else {
      await navigator.clipboard?.writeText(textToCopy);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleShowInFolder = (targetPath?: string) => {
    const p = targetPath || activeFile?.filePath;
    if (!ipcRenderer || !p || ssh) return;
    ipcRenderer.invoke('shell:show-item', p);
  };

  // ============================================================================
  // 檔案管理動作（搭配 react-arborist：改名、拖曳移動、複製/剪下/貼上、新增、刪除）
  // ============================================================================

  // 組裝給 react-arborist 的資料（含頂端 '..' 上一層目錄，可直接作為拖曳放入的目標！）
  const treeData: ArboristFileNode[] = useMemo(() => {
    const filtered = showHidden
      ? items
      : items.filter((item) => !item.isHidden && !item.name.startsWith('.'));

    const nodes: ArboristFileNode[] = filtered.map((item) => ({
      ...item,
      id: item.path,
    }));

    if (parentDir) {
      nodes.unshift({
        id: parentDir,
        name: '..',
        path: parentDir,
        isDirectory: true,
        isParentLink: true,
      });
    }
    return nodes;
  }, [items, showHidden, parentDir]);

  // 1. 原地重新命名 (F2 或右鍵 -> 重新命名)
  const handleArboristRename = useCallback(
    async ({ id, name, node }: { id: string; name: string; node: any }) => {
      if (!ipcRenderer || node?.data?.isParentLink) return;
      const trimmed = (name || '').trim();
      if (!trimmed || trimmed === node?.data?.name) return;

      const res = await ipcRenderer.invoke('fs:rename-item', {
        oldPath: id,
        newName: trimmed,
        ssh,
      });
      if (res?.success) {
        showOpToast(`已重新命名為「${trimmed}」`);
        await loadDirectory(currentDirRef.current);
      } else {
        showOpToast(`重新命名失敗：${res?.error || '未知錯誤'}`);
      }
    },
    [ssh, loadDirectory, showOpToast]
  );

  // 2. 拖曳移動 (支援單選或多選拖進子資料夾，或拖進 '..' 移往上一層目錄)
  const handleArboristMove = useCallback(
    async ({ dragIds, parentId }: { dragIds: string[]; parentId: string | null }) => {
      if (!ipcRenderer || !parentId) return;
      const validSources = dragIds.filter((id) => id !== parentId && id !== parentDir);
      if (validSources.length === 0) return;

      const res = await ipcRenderer.invoke('fs:move-items', {
        sourcePaths: validSources,
        targetDir: parentId,
        ssh,
      });
      if (res?.success) {
        const destName = parentId === parentDir ? '上一層目錄' : parentId.split(/[\\/]/).pop() || parentId;
        showOpToast(`已移動 ${validSources.length} 個項目至「${destName}」`);
        await loadDirectory(currentDirRef.current);
      } else {
        showOpToast(`移動失敗：${res?.error || '未知錯誤'}`);
      }
    },
    [ssh, parentDir, loadDirectory, showOpToast]
  );

  // 3. 複製 / 剪下 / 貼上
  const handleCopyOrCutItems = useCallback(
    (nodes: ArboristFileNode[], mode: 'copy' | 'cut') => {
      const valid = nodes.filter((n) => !n.isParentLink);
      if (valid.length === 0) return;
      setFileClipboard({
        paths: valid.map((n) => n.path),
        mode,
        sshId: ssh?.id,
      });
      showOpToast(
        mode === 'copy'
          ? `已複製 ${valid.length} 個項目`
          : `已剪下 ${valid.length} 個項目（可至目標目錄貼上）`
      );
    },
    [ssh?.id, showOpToast]
  );

  const handlePasteItems = useCallback(
    async (targetDirPath?: string) => {
      if (!ipcRenderer || !fileClipboard || fileClipboard.paths.length === 0) return;
      if ((fileClipboard.sshId || undefined) !== (ssh?.id || undefined)) {
        showOpToast('目前僅支援在同一台主機內複製貼上檔案');
        return;
      }
      const destDir = targetDirPath || currentDirRef.current;
      const res = await ipcRenderer.invoke('fs:paste-items', {
        sourcePaths: fileClipboard.paths,
        targetDir: destDir,
        mode: fileClipboard.mode,
        ssh,
      });
      if (res?.success) {
        showOpToast(`已貼上 ${fileClipboard.paths.length} 個項目`);
        if (fileClipboard.mode === 'cut') {
          setFileClipboard(null);
        }
        await loadDirectory(currentDirRef.current);
      } else {
        showOpToast(`貼上失敗：${res?.error || '未知錯誤'}`);
      }
    },
    [fileClipboard, ssh, loadDirectory, showOpToast]
  );

  // 4. 新增檔案或資料夾提交
  const submitCreateItem = useCallback(async () => {
    if (!creatingItem || !ipcRenderer) {
      setCreatingItem(null);
      return;
    }
    const name = creatingItem.value.trim();
    const isDir = creatingItem.isDirectory;
    setCreatingItem(null);
    if (!name) return;

    const res = await ipcRenderer.invoke('fs:create-item', {
      parentDir: currentDirRef.current,
      name,
      isDirectory: isDir,
      ssh,
    });
    if (res?.success) {
      showOpToast(isDir ? `已建立資料夾「${name}」` : `已建立檔案「${name}」`);
      await loadDirectory(currentDirRef.current);
      if (!isDir && res.path) {
        openFile(res.path, name);
      }
    } else {
      showOpToast(`建立失敗：${res?.error || '未知錯誤'}`);
    }
  }, [creatingItem, ssh, loadDirectory, openFile, showOpToast]);

  // 5. 刪除確認與執行
  const confirmDeleteItems = useCallback(async () => {
    if (!deleteTargets || deleteTargets.length === 0 || !ipcRenderer) {
      setDeleteTargets(null);
      return;
    }
    const paths = deleteTargets.map((n) => n.path);
    setDeleteTargets(null);
    const res = await ipcRenderer.invoke('fs:delete-items', {
      paths,
      ssh,
    });
    if (res?.success) {
      showOpToast(res.trashed ? `已將 ${paths.length} 個項目移至資源回收筒` : `已刪除 ${paths.length} 個項目`);
      await loadDirectory(currentDirRef.current);
    } else {
      showOpToast(`刪除失敗：${res?.error || '未知錯誤'}`);
    }
  }, [deleteTargets, ssh, loadDirectory, showOpToast]);

  // 鍵盤快捷鍵支援：在檔案樹中按 Ctrl+C / Ctrl+X / Ctrl+V
  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (activeFile || isEditingPath || creatingItem || deleteTargets) return;
      const tree = treeRef.current;
      if (!tree || tree.isEditing) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        const selected = tree.selectedNodes.map((n) => n.data).filter((d) => !d.isParentLink);
        if (selected.length > 0) {
          e.preventDefault();
          handleCopyOrCutItems(selected, 'copy');
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
        const selected = tree.selectedNodes.map((n) => n.data).filter((d) => !d.isParentLink);
        if (selected.length > 0) {
          e.preventDefault();
          handleCopyOrCutItems(selected, 'cut');
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        if (fileClipboard && fileClipboard.paths.length > 0) {
          e.preventDefault();
          handlePasteItems(currentDirRef.current);
        }
      }
    },
    [activeFile, isEditingPath, creatingItem, deleteTargets, fileClipboard, handleCopyOrCutItems, handlePasteItems]
  );

  // 開啟右鍵選單（支援單選、多選與空白區右鍵）
  const openNodeContextMenu = useCallback(
    (e: React.MouseEvent, targetNode?: ArboristFileNode) => {
      e.preventDefault();
      e.stopPropagation();

      const tree = treeRef.current;
      let selectedData: ArboristFileNode[] = [];

      if (targetNode && !targetNode.isParentLink) {
        if (tree && !tree.isSelected(targetNode.id)) {
          tree.select(targetNode.id);
          selectedData = [targetNode];
        } else if (tree) {
          selectedData = tree.selectedNodes.map((n) => n.data).filter((d) => !d.isParentLink);
        } else {
          selectedData = [targetNode];
        }
      }

      const isSingle = selectedData.length === 1;
      const singleItem = isSingle ? selectedData[0] : null;
      const canPaste =
        !!fileClipboard &&
        fileClipboard.paths.length > 0 &&
        (fileClipboard.sshId || undefined) === (ssh?.id || undefined);

      const menuItems: ContextMenuItem[] = [];

      if (singleItem) {
        menuItems.push({
          label: singleItem.isDirectory ? '進入資料夾' : '開啟檔案',
          icon: singleItem.isDirectory ? <FolderOpenIcon size={14} /> : <FileCode size={14} />,
          onClick: () => {
            if (singleItem.isDirectory) loadDirectory(singleItem.path);
            else openFile(singleItem.path, singleItem.name);
          },
        });
        menuItems.push({ separator: true });
      }

      menuItems.push(
        {
          label: '新增檔案…',
          icon: <FilePlus size={14} />,
          onClick: () => setCreatingItem({ isDirectory: false, value: '' }),
        },
        {
          label: '新增資料夾…',
          icon: <FolderPlus size={14} />,
          onClick: () => setCreatingItem({ isDirectory: true, value: '' }),
        }
      );

      if (selectedData.length > 0) {
        menuItems.push({ separator: true });
        if (isSingle && singleItem) {
          menuItems.push({
            label: '重新命名 (F2)',
            icon: <Pencil size={14} />,
            onClick: () => {
              treeRef.current?.edit(singleItem.id);
            },
          });
        }
        menuItems.push(
          {
            label: selectedData.length > 1 ? `複製 (${selectedData.length} 個項目)` : '複製 (Ctrl+C)',
            icon: <Copy size={14} />,
            onClick: () => handleCopyOrCutItems(selectedData, 'copy'),
          },
          {
            label: selectedData.length > 1 ? `剪下 (${selectedData.length} 個項目)` : '剪下 (Ctrl+X)',
            icon: <Scissors size={14} />,
            onClick: () => handleCopyOrCutItems(selectedData, 'cut'),
          }
        );
      }

      if (canPaste) {
        menuItems.push({
          label:
            singleItem && singleItem.isDirectory
              ? `貼上至「${singleItem.name}」`
              : `貼上 (${fileClipboard!.paths.length} 個項目)`,
          icon: <ClipboardPaste size={14} />,
          onClick: () =>
            handlePasteItems(singleItem && singleItem.isDirectory ? singleItem.path : currentDirRef.current),
        });
      }

      if (isSingle && singleItem) {
        menuItems.push({ separator: true });
        menuItems.push({
          label: '複製完整路徑',
          icon: <CopyPathIcon size={14} />,
          onClick: async () => {
            const fullText = ssh ? `${ssh.host}:${singleItem.path}` : singleItem.path;
            if (ipcRenderer) await ipcRenderer.invoke('clipboard:write', fullText);
            showOpToast('已複製路徑');
          },
        });
        if (!ssh) {
          menuItems.push({
            label: '在檔案總管中顯示',
            icon: <FolderOpen size={14} />,
            onClick: () => handleShowInFolder(singleItem.path),
          });
        }
      }

      if (selectedData.length > 0) {
        menuItems.push({ separator: true });
        menuItems.push({
          label: selectedData.length > 1 ? `刪除 (${selectedData.length} 個項目)` : '刪除 (Delete)',
          icon: <Trash2 size={14} />,
          danger: true,
          onClick: () => setDeleteTargets(selectedData),
        });
      }

      setContextMenu({ x: e.clientX, y: e.clientY, items: menuItems });
    },
    [fileClipboard, ssh, loadDirectory, openFile, handleCopyOrCutItems, handlePasteItems, showOpToast]
  );

  const normPathCompare = (p: string) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const isAtWorkspaceRoot = normPathCompare(currentDir) === normPathCompare(currentWorkspace);

  // 當使用者在頂部目錄列點擊上一層 / 回根目錄 / 輸入路徑時，若正開著檔案則一併返回目錄列表
  const navigateDirectoryFromHeader = useCallback(
    (targetPath: string) => {
      setActiveFile(null);
      setFileError(null);
      loadDirectory(targetPath);
    },
    [loadDirectory]
  );

  // 共用頂部路徑導覽列：
  // - 在目錄模式時顯示 currentDir，按「↑」前往 parentDir
  // - 在檔案模式時顯示 activeFile.filePath，按「↑」返回該檔案所在的檔案樹 (currentDir)
  const renderDirectoryHeader = () => {
    const isViewingFile = !!(activeFile || fileLoading);
    const displayedPath = activeFile ? activeFile.filePath : currentDir;
    const canGoUp = isViewingFile || (!!parentDir && !dirLoading);
    const upTitle = isViewingFile
      ? `返回上一層檔案樹 (${currentDir})`
      : parentDir
        ? `上一層目錄 (${parentDir})`
        : '已在最頂層根目錄';

    const handleGoUp = () => {
      if (isViewingFile) {
        setActiveFile(null);
        setFileError(null);
        return;
      }
      if (parentDir) {
        loadDirectory(parentDir);
      }
    };

    return (
      <div className="h-10 px-1.5 bg-[#18181b] border-b border-[#27272a] flex items-center gap-1 text-sm text-zinc-400 shrink-0">
        {/* 上一層按鈕：在檔案內按回檔案樹，在檔案樹按回父目錄 */}
        <button
          onClick={handleGoUp}
          disabled={!canGoUp}
          title={upTitle}
          className={`p-1.5 rounded transition shrink-0 ${
            canGoUp
              ? 'hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100'
              : 'text-zinc-600 cursor-not-allowed'
          }`}
        >
          <ArrowUp size={14} />
        </button>

        {/* 目前所在路徑（檔案模式顯示檔案路徑，目錄模式顯示目錄路徑；點擊可手動輸入目錄跳轉） */}
        <div className="flex-1 min-w-0">
          {isEditingPath ? (
            <input
              autoFocus
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onBlur={() => setIsEditingPath(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const trimmed = pathInput.trim();
                  setIsEditingPath(false);
                  if (trimmed) navigateDirectoryFromHeader(trimmed);
                } else if (e.key === 'Escape') {
                  setPathInput(currentDir);
                  setIsEditingPath(false);
                }
              }}
              className="w-full bg-[#121214] border border-zinc-600 rounded px-2 py-0.5 text-xs font-mono text-zinc-100 outline-none"
              placeholder="輸入目錄路徑..."
            />
          ) : (
            <div
              onClick={() => {
                setPathInput(currentDir);
                setIsEditingPath(true);
              }}
              title={`${ssh ? `[SSH ${ssh.host}] ` : ''}${displayedPath}\n（點擊可直接輸入目錄路徑跳轉）`}
              className="px-2 py-1 rounded bg-zinc-900/80 hover:bg-zinc-800/80 border border-zinc-800/80 text-xs font-mono text-zinc-200 truncate cursor-text transition"
            >
              {displayedPath}
            </div>
          )}
        </div>

        {/* 主畫面（回到工作區根目錄）按鈕：位於右側、眼睛按鈕左側 */}
        <button
          onClick={() => navigateDirectoryFromHeader(currentWorkspace)}
          disabled={isAtWorkspaceRoot && !isViewingFile}
          title={`回到工作區根目錄 (${currentWorkspace})`}
          className={`p-1.5 rounded transition shrink-0 ${
            !isAtWorkspaceRoot || isViewingFile
              ? 'hover:bg-zinc-800 text-amber-400/90 hover:text-amber-300'
              : 'text-zinc-600 cursor-not-allowed'
          }`}
        >
          <Home size={13} />
        </button>

        {/* 顯示 / 隱藏 . 開頭隱藏檔切換按鈕 */}
        <button
          onClick={toggleShowHidden}
          title={showHidden ? '目前顯示隱藏檔（點擊隱藏 . 開頭檔案）' : '目前隱藏 . 開頭檔案（點擊顯示隱藏檔）'}
          className={`p-1.5 rounded transition shrink-0 ${
            showHidden
              ? 'bg-zinc-800/90 text-amber-300 hover:bg-zinc-700'
              : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
          }`}
        >
          {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>

        {/* 重新整理按鈕 */}
        <button
          onClick={() => {
            if (activeFile) {
              openFile(activeFile.filePath, activeFile.name);
            } else {
              loadDirectory(currentDir);
            }
          }}
          title={activeFile ? '重新載入目前檔案' : '重新整理目前目錄'}
          className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition shrink-0"
        >
          <RefreshCw size={13} className={dirLoading || fileLoading ? 'animate-spin text-amber-400' : ''} />
        </button>
      </div>
    );
  };

  // ============================================================================
  // 滿版模式 A：檔案檢視與編輯器 (File Viewer / Monaco Editor)
  // ============================================================================
  if (activeFile || fileLoading) {
    const canToggleMarkdown = activeFile && activeFile.kind === 'text' && isMarkdownFile(activeFile.name);
    const canToggleSvgCode =
      activeFile && activeFile.kind === 'image' && activeFile.content !== undefined;
    const isCodeEditorVisible =
      activeFile &&
      ((activeFile.kind === 'text' && (!canToggleMarkdown || viewMode === 'code')) ||
        (canToggleSvgCode && viewMode === 'code'));

    return (
      <div className="h-full flex flex-col bg-[#121214] overflow-hidden select-none">
        {/* 第一排：顯示該檔案路徑，按「↑ 上一層」直接回到該檔案所在目錄的檔案樹 */}
        {renderDirectoryHeader()}

        {/* 第二排：檔案資訊與工具按鈕列 */}
        <div className="h-9 px-2.5 bg-[#151518] border-b border-[#27272a] flex items-center justify-between gap-1.5 text-xs shrink-0">
          {/* 左側：檔名 + 未儲存標記 + 檔案大小 */}
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {activeFile && (
              <div
                className="flex items-center gap-1.5 min-w-0 flex-1"
                title={ssh ? `${ssh.host}:${activeFile.filePath}` : activeFile.filePath}
              >
                {getFileIcon(activeFile.name)}
                <span className="font-mono text-zinc-200 font-medium truncate">
                  {activeFile.name}
                </span>
                {isDirty && (
                  <span
                    title="有尚未儲存的變更 (Ctrl+S)"
                    className="w-2 h-2 rounded-full bg-amber-400 shrink-0"
                  />
                )}
                {activeFile.size > 0 && (
                  <span className="text-[11px] text-zinc-500 font-mono shrink-0">
                    ({formatBytes(activeFile.size)})
                  </span>
                )}
              </div>
            )}
          </div>

          {/* 右側：檢視/編輯動作按鈕 */}
          {activeFile && !fileLoading && !fileError && (
            <div className="flex items-center gap-1 shrink-0">
              {saveToast && (
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  {saveToast}
                </span>
              )}

              {/* Markdown 或 SVG：預覽 ↔ 原始碼切換 */}
              {(canToggleMarkdown || canToggleSvgCode) && (
                <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded p-0.5 mr-0.5">
                  <button
                    onClick={() => setViewMode('preview')}
                    title="渲染預覽"
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition ${
                      viewMode === 'preview'
                        ? 'bg-zinc-700 text-zinc-100 font-medium'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <BookOpen size={11} />
                    <span>預覽</span>
                  </button>
                  <button
                    onClick={() => setViewMode('code')}
                    title="Monaco 原始碼編輯"
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition ${
                      viewMode === 'code'
                        ? 'bg-zinc-700 text-zinc-100 font-medium'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <Code size={11} />
                    <span>原始碼</span>
                  </button>
                </div>
              )}

              {/* 自動折行切換（僅在 Monaco 顯示時） */}
              {isCodeEditorVisible && (
                <button
                  onClick={toggleWordWrap}
                  title={wordWrap ? '關閉自動折行 (Word Wrap)' : '開啟自動折行 (Word Wrap)'}
                  className={`p-1 rounded transition ${
                    wordWrap
                      ? 'bg-zinc-800 text-amber-300'
                      : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                  }`}
                >
                  <WrapText size={13} />
                </button>
              )}

              {/* 倒退 (Undo) 與 向前 (Redo) 按鈕（僅在 Monaco 顯示且非唯讀時） */}
              {isCodeEditorVisible && !activeFile.truncated && (
                <>
                  <button
                    onClick={() => monacoEditorRef.current?.undo()}
                    title="倒退 / 復原 (Ctrl+Z)"
                    className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition"
                  >
                    <Undo2 size={13} />
                  </button>
                  <button
                    onClick={() => monacoEditorRef.current?.redo()}
                    title="向前 / 重做 (Ctrl+Y)"
                    className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition"
                  >
                    <Redo2 size={13} />
                  </button>
                </>
              )}

              {/* 儲存按鈕（純圖示、無文字，支援文字與 SVG 原始碼） */}
              {activeFile.content !== undefined && !activeFile.truncated && (
                <button
                  onClick={handleSaveFile}
                  disabled={saving || !isDirty}
                  title="儲存檔案 (Ctrl+S)"
                  className={`p-1 rounded transition ${
                    isDirty
                      ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-sm'
                      : 'text-zinc-500 cursor-default'
                  }`}
                >
                  {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                </button>
              )}

              {/* 複製內容（或複製路徑） */}
              <button
                onClick={handleCopyContent}
                title={activeFile.content !== undefined ? '複製檔案內容' : '複製檔案路徑'}
                className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition"
              >
                {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
              </button>

              {/* 重新讀取檔案 */}
              <button
                onClick={() => openFile(activeFile.filePath, activeFile.name)}
                title="重新載入檔案"
                className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition"
              >
                <RefreshCw size={13} />
              </button>

              {/* 本機：在檔案總管中顯示 */}
              {!ssh && (
                <button
                  onClick={() => handleShowInFolder(activeFile.filePath)}
                  title="在系統檔案總管中顯示"
                  className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition"
                >
                  <FolderOpen size={13} />
                </button>
              )}
            </div>
          )}
        </div>

        {/* 超大檔案截斷提示 */}
        {activeFile?.truncated && (
          <div className="px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-xs flex items-center gap-2">
            <AlertCircle size={14} className="shrink-0" />
            <span>檔案超過 2 MB，目前僅預覽前 2 MB 內容（唯讀模式，避免覆寫損毀原檔）。</span>
          </div>
        )}

        {/* 主內容區 */}
        <div className="flex-1 overflow-hidden relative select-text">
          {fileLoading ? (
            <div className="h-full flex items-center justify-center gap-2 text-xs text-zinc-400 font-mono">
              <Loader2 size={15} className="animate-spin text-amber-400" />
              <span>正在讀取檔案...</span>
            </div>
          ) : fileError ? (
            <div className="h-full flex flex-col items-center justify-center p-6 text-center gap-3">
              <AlertCircle size={28} className="text-red-400" />
              <div className="text-sm text-zinc-300 font-medium">無法開啟檔案</div>
              <div className="text-xs text-zinc-500 font-mono break-all max-w-sm">{fileError}</div>
            </div>
          ) : activeFile?.kind === 'binary' ? (
            <div className="h-full flex flex-col items-center justify-center p-6 text-center gap-3">
              <File size={32} className="text-zinc-500" />
              <div className="text-sm text-zinc-300 font-medium">二進位或大型媒體檔案</div>
              <div className="text-xs text-zinc-500">
                檔案大小：{formatBytes(activeFile.size)}。此格式無法直接以文字編輯器開啟。
              </div>
              {!ssh && (
                <button
                  onClick={() => handleShowInFolder(activeFile.filePath)}
                  className="mt-1 px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 flex items-center gap-1.5 transition"
                >
                  <FolderOpen size={13} />
                  <span>在檔案總管中顯示</span>
                </button>
              )}
            </div>
          ) : activeFile?.kind === 'image' && viewMode === 'preview' ? (
            <div className="h-full flex flex-col overflow-hidden">
              {/* 圖片預覽控制列 */}
              <div className="h-8 px-3 bg-[#151518] border-b border-[#27272a] flex items-center justify-between text-xs text-zinc-400 select-none">
                <span className="font-mono text-[11px]">
                  {imageDimensions ? `${imageDimensions.w} × ${imageDimensions.h} px` : '圖片預覽'}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setImageZoom((z) => Math.max(25, z - 25))}
                    title="縮小"
                    className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                  >
                    <ZoomOut size={13} />
                  </button>
                  <span className="font-mono text-[11px] w-12 text-center">{imageZoom}%</span>
                  <button
                    onClick={() => setImageZoom((z) => Math.min(400, z + 25))}
                    title="放大"
                    className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                  >
                    <ZoomIn size={13} />
                  </button>
                  <button
                    onClick={() => setImageZoom(100)}
                    title="重設縮放 (100%)"
                    className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                  >
                    <RotateCcw size={12} />
                  </button>
                </div>
              </div>
              {/* 棋盤格背景圖片畫布 */}
              <div
                className="flex-1 overflow-auto flex items-center justify-center p-4"
                style={{
                  backgroundImage:
                    'linear-gradient(45deg, #1c1c20 25%, transparent 25%), linear-gradient(-45deg, #1c1c20 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1c1c20 75%), linear-gradient(-45deg, transparent 75%, #1c1c20 75%)',
                  backgroundSize: '16px 16px',
                  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
                }}
              >
                {activeFile.dataUrl && (
                  <img
                    src={activeFile.dataUrl}
                    alt={activeFile.name}
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      if (img.naturalWidth && img.naturalHeight) {
                        setImageDimensions({ w: img.naturalWidth, h: img.naturalHeight });
                      }
                    }}
                    style={{
                      width: imageZoom === 100 ? undefined : `${imageZoom}%`,
                      maxWidth: imageZoom === 100 ? '100%' : 'none',
                      maxHeight: imageZoom === 100 ? '100%' : 'none',
                    }}
                    className="object-contain rounded shadow-lg"
                  />
                )}
              </div>
            </div>
          ) : canToggleMarkdown && viewMode === 'preview' ? (
            <div className="h-full overflow-y-auto p-4 bg-[#121214]">
              <Markdown>{editedContent}</Markdown>
            </div>
          ) : activeFile ? (
            <Suspense
              fallback={
                <div className="h-full flex items-center justify-center gap-2 text-xs text-zinc-500 font-mono">
                  <Loader2 size={14} className="animate-spin text-amber-400" />
                  <span>載入 Monaco Editor...</span>
                </div>
              }
            >
              <MonacoCodeEditor
                ref={monacoEditorRef}
                filePath={activeFile.filePath}
                fileName={activeFile.name}
                value={editedContent}
                readOnly={!!activeFile.truncated}
                wordWrap={wordWrap}
                onChange={(val) => setEditedContent(val)}
                onSave={handleSaveFile}
              />
            </Suspense>
          ) : null}
        </div>
      </div>
    );
  }

  // ============================================================================
  // 滿版模式 B：react-arborist 檔案樹與目錄瀏覽（支援拖曳移動、F2 改名、多選、右鍵選單）
  // ============================================================================
  return (
    <div
      className="h-full flex flex-col bg-[#121214] overflow-hidden select-none relative"
      onKeyDown={handleTreeKeyDown}
    >
      {/* 頂部導覽列 */}
      {renderDirectoryHeader()}

      {/* 若正在新增檔案或資料夾，顯示頂端內嵌輸入列 */}
      {creatingItem && (
        <div className="px-2 py-1.5 bg-[#18181b] border-b border-[#27272a] flex items-center gap-2 shrink-0">
          {creatingItem.isDirectory ? (
            <Folder size={14} className="text-amber-300 shrink-0" />
          ) : (
            <File size={14} className="text-blue-400 shrink-0" />
          )}
          <input
            autoFocus
            value={creatingItem.value}
            onChange={(e) => setCreatingItem({ ...creatingItem, value: e.target.value })}
            onBlur={submitCreateItem}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCreateItem();
              else if (e.key === 'Escape') setCreatingItem(null);
            }}
            placeholder={creatingItem.isDirectory ? '輸入新資料夾名稱 (Enter 建立)…' : '輸入新檔案名稱 (Enter 建立)…'}
            className="flex-1 bg-[#121214] border border-blue-500/70 rounded px-2 py-0.5 text-xs font-mono text-zinc-100 outline-none"
          />
        </div>
      )}

      {/* 目錄內容列表 (react-arborist) */}
      <div
        ref={treeContainerRef}
        className="flex-1 overflow-hidden relative"
        onContextMenu={(e) => openNodeContextMenu(e)}
      >
        {dirError ? (
          <div className="p-4 text-center space-y-2">
            <div className="text-xs text-red-400 font-mono break-all">{dirError}</div>
            <button
              onClick={() => loadDirectory(currentWorkspace)}
              className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 transition"
            >
              返回工作區根目錄
            </button>
          </div>
        ) : dirLoading && items.length === 0 ? (
          <div className="h-32 flex items-center justify-center gap-2 text-xs text-zinc-500 font-mono">
            <Loader2 size={14} className="animate-spin text-amber-400" />
            <span>正在讀取目錄...</span>
          </div>
        ) : treeData.length === 0 ? (
          <div className="py-8 text-center text-xs text-zinc-500">
            此目錄下沒有檔案（按右鍵可新增檔案或資料夾）
          </div>
        ) : (
          <Tree<ArboristFileNode>
            ref={treeRef}
            data={treeData}
            width={treeSize.width}
            height={treeSize.height}
            rowHeight={28}
            indent={14}
            paddingTop={4}
            paddingBottom={8}
            childrenAccessor={(d) => (d.isDirectory ? [] : null)}
            disableDrag={(d) => !!d.isParentLink}
            disableEdit={(d) => !!d.isParentLink}
            disableDrop={({ parentNode, dragNodes }) => {
              // 僅允許拖入資料夾（或 '..' 上一層目錄），禁止在根目錄同層無意義排序或拖入自身
              if (parentNode.isRoot) return true;
              if (!parentNode.data?.isDirectory) return true;
              if (dragNodes.some((n) => n.id === parentNode.id)) return true;
              return false;
            }}
            onRename={handleArboristRename}
            onMove={handleArboristMove}
            onDelete={({ nodes }) => {
              const valid = nodes.map((n) => n.data).filter((d) => !d.isParentLink);
              if (valid.length > 0) setDeleteTargets(valid);
            }}
            onActivate={(node) => {
              // 按下 Enter 或雙擊觸發開啟
              if (node.data.isDirectory) {
                loadDirectory(node.data.path);
              } else {
                openFile(node.data.path, node.data.name);
              }
            }}
          >
            {({ node, style, dragHandle }: NodeRendererProps<ArboristFileNode>) => {
              const item = node.data;
              const isHiddenItem = item.isHidden || (!item.isParentLink && item.name.startsWith('.'));
              const isCut =
                fileClipboard?.mode === 'cut' && fileClipboard.paths.includes(item.path);

              return (
                <div
                  ref={dragHandle}
                  style={style}
                  onClick={(e) => {
                    if (node.isEditing) return;
                    // 若按住 Ctrl / Cmd / Shift 則走多選邏輯，不進入目錄或開檔
                    if (e.ctrlKey || e.metaKey || e.shiftKey) {
                      node.handleClick(e);
                      return;
                    }
                    // 一般單擊：更新選取狀態並直接進入資料夾或開啟檔案（仍可透過右鍵或 Ctrl+Click 選取後按 F2/Delete）
                    node.handleClick(e);
                    if (item.isDirectory) {
                      loadDirectory(item.path);
                    } else {
                      openFile(item.path, item.name);
                    }
                  }}
                  onContextMenu={(e) => openNodeContextMenu(e, item)}
                  title={item.isParentLink ? `返回上一層目錄 (${item.path})\n（亦可將檔案拖曳至此移往上一層）` : item.path}
                  className={`mx-1.5 px-2 rounded flex items-center justify-between text-sm cursor-pointer transition ${
                    node.willReceiveDrop
                      ? 'bg-blue-500/25 ring-1 ring-blue-400 text-white'
                      : node.isSelected
                        ? 'bg-zinc-700/70 text-zinc-100'
                        : 'hover:bg-zinc-800/60'
                  } ${isCut ? 'opacity-45' : ''} ${
                    isHiddenItem ? 'text-zinc-400/75' : 'text-zinc-200'
                  }`}
                >
                  <div className="flex items-center space-x-2 min-w-0 flex-1">
                    {item.isDirectory ? (
                      <Folder
                        size={14}
                        className={`shrink-0 ${
                          node.willReceiveDrop
                            ? 'text-blue-300'
                            : isHiddenItem || item.isParentLink
                              ? 'text-amber-300/55'
                              : 'text-amber-300/90'
                        }`}
                      />
                    ) : (
                      getFileIcon(item.name)
                    )}

                    {node.isEditing ? (
                      <input
                        autoFocus
                        defaultValue={item.name}
                        onFocus={(e) => {
                          const val = e.currentTarget.value;
                          const dotIdx = !item.isDirectory ? val.lastIndexOf('.') : -1;
                          if (dotIdx > 0) {
                            e.currentTarget.setSelectionRange(0, dotIdx);
                          } else {
                            e.currentTarget.select();
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => node.submit(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') node.submit(e.currentTarget.value);
                          else if (e.key === 'Escape') node.reset();
                        }}
                        className="flex-1 min-w-0 bg-[#121214] border border-blue-500 rounded px-1.5 py-0 text-xs font-mono text-zinc-100 outline-none"
                      />
                    ) : (
                      <span className={`truncate ${item.isParentLink ? 'font-mono text-zinc-400' : ''}`}>
                        {item.name}
                      </span>
                    )}
                  </div>

                  {!item.isDirectory && !node.isEditing && item.size !== undefined && (
                    <span className="text-[11px] font-mono text-zinc-500 ml-2 shrink-0">
                      {formatBytes(item.size)}
                    </span>
                  )}
                </div>
              );
            }}
          </Tree>
        )}
      </div>

      {/* 右鍵選單 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* 刪除確認彈窗 */}
      {deleteTargets && deleteTargets.length > 0 && (
        <div
          className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60"
          onMouseDown={() => setDeleteTargets(null)}
        >
          <div
            className="w-[400px] rounded-xl border border-[#3f3f46] bg-[#1f1f23] p-5 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-red-400 mb-2 flex items-center gap-2">
              <AlertTriangle size={15} /> 確認刪除
            </h3>
            <p className="text-sm text-zinc-300 leading-relaxed">
              {deleteTargets.length === 1 ? (
                <>
                  確定要刪除「<span className="font-mono text-zinc-100">{deleteTargets[0].name}</span>」嗎？
                </>
              ) : (
                <>
                  確定要刪除選取的 <span className="font-mono text-zinc-100">{deleteTargets.length}</span> 個項目嗎？
                </>
              )}
              <br />
              <span className="text-xs text-zinc-500">
                {ssh
                  ? '注意：遠端 SSH 檔案刪除後無法從回收筒還原。'
                  : '本機檔案會優先移至系統資源回收筒。'}
              </span>
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeleteTargets(null)}
                className="px-3 py-1.5 rounded-md text-sm text-zinc-300 hover:bg-zinc-800 transition"
              >
                取消
              </button>
              <button
                onClick={confirmDeleteItems}
                className="px-3 py-1.5 rounded-md text-sm bg-red-600 hover:bg-red-500 text-white transition"
              >
                刪除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 操作狀態輕量提示 (Toast) */}
      {opToast && (
        <div className="absolute bottom-3 left-3 right-3 z-50 rounded-md border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-xs text-zinc-200 shadow-lg truncate text-center pointer-events-none">
          {opToast}
        </div>
      )}
    </div>
  );
};
