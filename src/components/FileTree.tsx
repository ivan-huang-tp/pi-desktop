import React, { useState } from 'react';
import { 
  Folder, 
  FolderOpen, 
  FileCode, 
  FileText, 
  File, 
  ChevronRight, 
  ChevronDown, 
  RefreshCw,
  Eye,
  X
} from 'lucide-react';
import type { FileItem } from '../types';

interface FileTreeProps {
  files: FileItem[];
  currentWorkspace: string;
  onRefresh?: () => void;
}

export const FileTree: React.FC<FileTreeProps> = ({
  files,
  currentWorkspace,
  onRefresh,
}) => {
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    'src': true,
    'src/components': true,
  });
  const [selectedFile, setSelectedFile] = useState<{ path: string; name: string; content?: string } | null>(null);

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => ({
      ...prev,
      [path]: !prev[path],
    }));
  };

  const getFileIcon = (fileName: string) => {
    if (fileName.endsWith('.tsx') || fileName.endsWith('.ts') || fileName.endsWith('.jsx') || fileName.endsWith('.js')) {
      return <FileCode size={14} className="text-blue-400 shrink-0" />;
    }
    if (fileName.endsWith('.json') || fileName.endsWith('.md')) {
      return <FileText size={14} className="text-amber-400 shrink-0" />;
    }
    if (fileName.endsWith('.css') || fileName.endsWith('.html')) {
      return <FileCode size={14} className="text-emerald-400 shrink-0" />;
    }
    return <File size={14} className="text-zinc-400 shrink-0" />;
  };

  const handleFileClick = (item: FileItem) => {
    // 模擬或打開檔案內容
    setSelectedFile({
      name: item.name,
      path: item.path,
      content: `// 檔案內容預覽: ${item.path}\n\n// 這裡會即時顯示 Pi 修改或檢視的程式碼內容。\n// 可以整合 Monaco Editor 或簡易 CodeViewer。`,
    });
  };

  const renderTree = (items: FileItem[], depth = 0) => {
    return items.map((item) => {
      const isExpanded = expandedFolders[item.path] ?? false;

      if (item.isDirectory) {
        return (
          <div key={item.path} className="text-sm">
            <div
              onClick={() => toggleFolder(item.path)}
              style={{ paddingLeft: `${depth * 12 + 6}px` }}
              className="flex items-center space-x-1.5 py-1 pr-1.5 rounded cursor-pointer hover:bg-zinc-800/60 transition text-zinc-300 group"
            >
              {isExpanded ? (
                <ChevronDown size={13} className="text-zinc-500" />
              ) : (
                <ChevronRight size={13} className="text-zinc-500" />
              )}
              {isExpanded ? (
                <FolderOpen size={14} className="text-amber-300/80" />
              ) : (
                <Folder size={14} className="text-amber-300/80" />
              )}
              <span className="truncate group-hover:text-zinc-100">{item.name}</span>
            </div>
            {isExpanded && item.children && (
              <div>{renderTree(item.children, depth + 1)}</div>
            )}
          </div>
        );
      }

      return (
        <div
          key={item.path}
          onClick={() => handleFileClick(item)}
          style={{ paddingLeft: `${depth * 12 + 18}px` }}
          className={`flex items-center space-x-2 py-1 pr-1.5 rounded cursor-pointer text-sm transition ${
            selectedFile?.path === item.path
              ? 'bg-zinc-700/60 text-zinc-100 font-medium'
              : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
          }`}
        >
          {getFileIcon(item.name)}
          <span className="truncate">{item.name}</span>
        </div>
      );
    });
  };

  return (
    <div className="h-full flex flex-col bg-[#121214] overflow-hidden">
      {/* 檔案樹頂部標題 */}
      <div className="h-10 px-2 bg-[#18181b] border-b border-[#27272a] flex items-center justify-between text-sm text-zinc-400 select-none">
        <span className="font-mono text-zinc-300 font-medium truncate max-w-[200px]" title={currentWorkspace}>
          Workspace Files
        </span>
        <button
          onClick={onRefresh}
          title="重新整理目錄"
          className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {/* 主體區塊：檔案樹或檔案預覽 */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {selectedFile ? (
          <div className="h-full flex flex-col bg-zinc-950/60 rounded border border-zinc-800/80 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 text-sm">
              <span className="font-mono text-zinc-300 truncate">{selectedFile.name}</span>
              <button
                onClick={() => setSelectedFile(null)}
                className="text-zinc-400 hover:text-zinc-100 p-0.5 rounded"
              >
                <X size={13} />
              </button>
            </div>
            <pre className="flex-1 p-3 text-sm font-mono text-zinc-300 overflow-auto whitespace-pre leading-relaxed select-text">
              {selectedFile.content}
            </pre>
          </div>
        ) : (
          <div className="space-y-0.5">{renderTree(files)}</div>
        )}
      </div>
    </div>
  );
};
