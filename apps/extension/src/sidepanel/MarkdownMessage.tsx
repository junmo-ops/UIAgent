import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
