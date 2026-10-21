import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

interface MarkdownProps {
  children: string;
}

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [[rehypeHighlight, { ignoreMissing: true }]] as const;

// 所有連結都以新分頁開啟（定義在模組層級，避免每次 render 都建立新物件）
const MARKDOWN_COMPONENTS = {
  a: ({ node, ...props }: any) => (
    <a {...props} target="_blank" rel="noreferrer noopener" />
  ),
};

// 以 React.memo 包裝：唯有 markdown 文字內容改變時才重新解析，
// 避免外層（例如輸入框打字）re-render 時不斷重新解析歷史訊息。
export const Markdown: React.FC<MarkdownProps> = React.memo(({ children }) => {
  return (
    <div className="md-body select-text">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS as any}
        components={MARKDOWN_COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

Markdown.displayName = 'Markdown';
