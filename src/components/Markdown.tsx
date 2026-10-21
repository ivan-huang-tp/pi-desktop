import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

interface MarkdownProps {
  children: string;
  onOpenPath?: (path: string) => void;
}

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [[rehypeHighlight, { ignoreMissing: true }]] as const;

// 常見程式碼與設定檔副檔名白名單（避免誤判 console.log / window.innerWidth 等屬性存取）
const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'jsonc', 'json5', 'jsonl',
  'md', 'mdx', 'markdown', 'txt', 'rst',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte', 'astro',
  'py', 'pyi', 'rb', 'php', 'java', 'kt', 'kts', 'scala', 'go', 'rs',
  'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cs', 'swift', 'm', 'mm',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'xml', 'svg', 'sql', 'graphql', 'gql', 'prisma', 'proto',
  'dockerfile', 'makefile', 'cmake', 'gradle', 'lock',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'pdf',
]);

// 常見無副檔名或點開頭設定檔
const SPECIAL_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'cmakelists.txt',
  'license',
  'readme',
  'changelog',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.nvmrc',
  '.editorconfig',
  '.prettierrc',
  '.eslintrc',
  '.env',
  '.env.example',
  '.env.local',
  '.env.development',
  '.env.production',
]);

/**
 * 去除路徑尾端的行號標記（例如 `src/App.tsx:120`、`src/App.tsx:10:5`、`src/App.tsx#L120-L145`）
 */
export function stripLineSuffix(raw: string): string {
  return raw
    .trim()
    .replace(/#L\d+(?:-L?\d+)?$/i, '')
    .replace(/:\d+(?::\d+)?(?=-\d+|\b).*$/, '');
}

/**
 * 判斷單行 inline code 字串是否為檔案路徑或目錄路徑
 */
export function extractClickablePath(rawText: string): string | null {
  if (!rawText) return null;
  const trimmed = rawText.trim();
  // 長度過短、過長、包含換行或空白、或是網址/協定開頭，一律排除
  if (
    trimmed.length < 2 ||
    trimmed.length > 260 ||
    /[\r\n\s]/.test(trimmed) ||
    /^(https?:|mailto:|tel:|data:|javascript:|ws:|wss:)/i.test(trimmed)
  ) {
    return null;
  }

  // 若是 file:// URI，轉為一般路徑
  let candidate = trimmed;
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = decodeURIComponent(candidate.replace(/^file:\/\/\/?/i, ''));
      // 若為 Unix 根路徑被拿掉斜線，保留原樣或交由後續處理
    } catch {
      return null;
    }
  }

  // 排除含有函式呼叫括號、指派、引號、比較符號等程式碼片段
  if (/[()[\]{}<>;='"`,?$!*|&^~]/.test(candidate)) {
    return null;
  }

  const cleaned = stripLineSuffix(candidate);
  if (!cleaned) return null;

  // 特殊完整檔名（如 Dockerfile, .gitignore）
  const baseLower = cleaned.toLowerCase();
  if (SPECIAL_FILENAMES.has(baseLower)) {
    return cleaned;
  }

  const hasSlash = cleaned.includes('/') || cleaned.includes('\\');
  const segments = cleaned.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return null;
  const lastSegment = segments[segments.length - 1];

  // 檢查最後一段是否有副檔名
  const dotIdx = lastSegment.lastIndexOf('.');
  const ext = dotIdx > 0 ? lastSegment.slice(dotIdx + 1).toLowerCase() : '';
  const hasKnownExt = ext !== '' && FILE_EXTENSIONS.has(ext);
  const isSpecialBase = SPECIAL_FILENAMES.has(lastSegment.toLowerCase());

  // 情況 1：不含斜線的單一檔名 → 必須有白名單副檔名（例如 `App.tsx`, `package.json`, `main.cjs`）
  if (!hasSlash) {
    if (hasKnownExt && /^[a-zA-Z0-9._-]+$/.test(lastSegment)) {
      return cleaned;
    }
    return null;
  }

  // 情況 2：含斜線的路徑（例如 `src/components/ChatArea.tsx`、`src/components/`、`./vite.config.ts`、`c:\aa-project\pi-ui`）
  // 排除純分數或簡單兩字斜線（例如 `a/b`, `true/false`, `yes/no`, `1/2`, `I/O`, `CI/CD`, `TCP/IP`, `UI/UX`）
  const isDriveOrRoot =
    /^[a-zA-Z]:[\\/]/.test(cleaned) ||
    cleaned.startsWith('./') ||
    cleaned.startsWith('../') ||
    cleaned.startsWith('.\\') ||
    cleaned.startsWith('..\\') ||
    cleaned.startsWith('/');

  const endsWithSlash = /[\\/]$/.test(cleaned);

  if (hasKnownExt || isSpecialBase || isDriveOrRoot || endsWithSlash || segments.length >= 3) {
    // 確保每一段都是合法檔名/目錄字元
    const validSegments = segments.every((seg, idx) => {
      if (idx === 0 && /^[a-zA-Z]:$/.test(seg)) return true;
      return /^[a-zA-Z0-9._@-]+$/.test(seg);
    });
    if (validSegments) {
      return cleaned;
    }
  }

  // 若為兩段路徑如 `src/components`、`electron/main`，只在第一段是常見專案目錄名稱時視為目錄路徑
  if (
    segments.length === 2 &&
    /^(src|electron|public|docs|scripts|reference|resources|server|client|lib|components|types|utils|hooks|assets|styles|test|tests|__tests__|config|dist|build)$/i.test(
      segments[0]
    ) &&
    segments.every((seg) => /^[a-zA-Z0-9._@-]+$/.test(seg))
  ) {
    return cleaned;
  }

  return null;
}

// 以 React.memo 包裝：唯有 markdown 文字內容改變時才重新解析，
// 避免外層（例如輸入框打字）re-render 時不斷重新解析歷史訊息。
export const Markdown: React.FC<MarkdownProps> = React.memo(({ children, onOpenPath }) => {
  const components = useMemo(
    () => ({
      a: ({ node, href, children: linkChildren, ...props }: any) => {
        const clickablePath = href ? extractClickablePath(href) : null;
        if (clickablePath && onOpenPath) {
          return (
            <a
              {...props}
              href={href}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenPath(clickablePath);
              }}
              title={clickablePath}
              className="!no-underline cursor-pointer text-indigo-300 hover:text-indigo-200 transition-colors"
            >
              {linkChildren}
            </a>
          );
        }
        return (
          <a {...props} href={href} target="_blank" rel="noreferrer noopener">
            {linkChildren}
          </a>
        );
      },
      code: ({ node, className, children: codeChildren, ...props }: any) => {
        const text = String(codeChildren ?? '').replace(/\n$/, '');
        // 多行或帶有語法高亮 className (hljs / language-*) 的為區塊程式碼，維持原樣
        const isBlock = Boolean(className) || text.includes('\n');
        if (!isBlock && onOpenPath) {
          const targetPath = extractClickablePath(text);
          if (targetPath) {
            return (
              <code
                {...props}
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenPath(targetPath);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpenPath(targetPath);
                  }
                }}
                title={targetPath}
                className="cursor-pointer hover:bg-zinc-600/60 hover:text-fuchsia-200 transition-colors"
              >
                {codeChildren}
              </code>
            );
          }
        }
        return (
          <code {...props} className={className}>
            {codeChildren}
          </code>
        );
      },
    }),
    [onOpenPath]
  );

  return (
    <div className="md-body select-text">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS as any}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

Markdown.displayName = 'Markdown';
