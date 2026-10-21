import React, { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import * as monaco from 'monaco-editor';
import Editor, { loader, OnMount, BeforeMount } from '@monaco-editor/react';

// 使用本地安裝的 monaco-editor（0.57+ 內建 ESM new Worker(new URL(..., import.meta.url))，Vite 會自動打包本地 Worker，完全不依賴外部 CDN）
loader.config({ monaco });

export function detectMonacoLanguage(fileName: string): string {
  const lower = (fileName || '').toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  if (lower === '.env' || lower.startsWith('.env.')) return 'shell';
  if (
    lower === '.gitignore' ||
    lower === '.dockerignore' ||
    lower === '.npmignore' ||
    lower === '.editorconfig'
  ) {
    return 'ini';
  }

  const ext = lower.includes('.') ? '.' + lower.split('.').pop()! : '';
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.json': 'json',
    '.jsonc': 'json',
    '.jsonl': 'json',
    '.md': 'markdown',
    '.mdx': 'markdown',
    '.markdown': 'markdown',
    '.css': 'css',
    '.scss': 'scss',
    '.less': 'less',
    '.html': 'html',
    '.htm': 'html',
    '.xml': 'xml',
    '.svg': 'xml',
    '.py': 'python',
    '.pyw': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.sh': 'shell',
    '.bash': 'shell',
    '.zsh': 'shell',
    '.ps1': 'powershell',
    '.psm1': 'powershell',
    '.bat': 'bat',
    '.cmd': 'bat',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.toml': 'ini',
    '.ini': 'ini',
    '.cfg': 'ini',
    '.conf': 'ini',
    '.sql': 'sql',
    '.php': 'php',
    '.rb': 'ruby',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.dart': 'dart',
    '.lua': 'lua',
    '.graphql': 'graphql',
    '.gql': 'graphql',
  };
  return map[ext] || 'plaintext';
}

export interface MonacoCodeEditorHandle {
  undo: () => void;
  redo: () => void;
}

interface MonacoCodeEditorProps {
  filePath: string;
  fileName: string;
  value: string;
  readOnly?: boolean;
  wordWrap?: boolean;
  minimap?: boolean;
  onChange?: (val: string) => void;
  onSave?: () => void;
}

export const MonacoCodeEditor = forwardRef<MonacoCodeEditorHandle, MonacoCodeEditorProps>(({
  filePath,
  fileName,
  value,
  readOnly = false,
  wordWrap = false,
  minimap = false,
  onChange,
  onSave,
}, ref) => {
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useImperativeHandle(ref, () => ({
    undo: () => {
      editorRef.current?.trigger('toolbar', 'undo', null);
      editorRef.current?.focus();
    },
    redo: () => {
      editorRef.current?.trigger('toolbar', 'redo', null);
      editorRef.current?.focus();
    },
  }));

  const handleBeforeMount: BeforeMount = (monacoInstance) => {
    // 定義契合 Pi-UI 深色風格的主題
    monacoInstance.editor.defineTheme('pi-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#121214',
        'editor.foreground': '#e4e4e7',
        'editorLineNumber.foreground': '#52525b',
        'editorLineNumber.activeForeground': '#a1a1aa',
        'editor.lineHighlightBackground': '#18181b',
        'editor.selectionBackground': '#3f3f4680',
        'editorWidget.background': '#18181b',
        'editorWidget.border': '#27272a',
        'editorGutter.background': '#121214',
      },
    });

    // 關閉單檔檢視時缺乏跨檔案型別定義所產生的假紅線，保留語法與高亮
    const tsDefaults = monacoInstance.languages.typescript?.typescriptDefaults;
    const jsDefaults = monacoInstance.languages.typescript?.javascriptDefaults;
    tsDefaults?.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
    jsDefaults?.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
  };

  const handleMount: OnMount = (editor, monacoInstance) => {
    editorRef.current = editor;
    // 綁定 Ctrl+S / Cmd+S 快捷鍵直接觸發儲存
    editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
      onSaveRef.current?.();
    });
  };

  // 當切換不同檔案時，確保捲軸回到頂部
  const editorLanguage = detectMonacoLanguage(fileName);

  useEffect(() => {
    // noop, path prop on Editor handles model switching cleanly
  }, [filePath]);

  return (
    <Editor
      path={filePath}
      language={editorLanguage}
      value={value}
      theme="pi-dark"
      beforeMount={handleBeforeMount}
      onMount={handleMount}
      onChange={(v) => onChange?.(v ?? '')}
      options={{
        readOnly,
        fontSize: 13,
        lineHeight: 20,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
        minimap: { enabled: minimap },
        wordWrap: wordWrap ? 'on' : 'off',
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        automaticLayout: true,
        tabSize: 2,
        renderLineHighlight: 'all',
        bracketPairColorization: { enabled: true },
        folding: true,
        padding: { top: 10, bottom: 10 },
        scrollbar: {
          verticalScrollbarSize: 8,
          horizontalScrollbarSize: 8,
        },
      }}
      loading={
        <div className="h-full w-full flex items-center justify-center text-xs text-zinc-500 font-mono">
          載入 Monaco 編輯器中...
        </div>
      }
    />
  );
});

MonacoCodeEditor.displayName = 'MonacoCodeEditor';
