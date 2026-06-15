'use client';

import { useState, useEffect, useRef } from 'react';
import { Loader2, Hash, WrapText, ZoomIn, ZoomOut } from 'lucide-react';

interface TextViewerProps {
  url: string;
  fileName: string;
}

// ===== 语法高亮颜色映射 =====
const LANGUAGE_COLORS: Record<string, { keyword: string; string: string; comment: string }> = {
  js: { keyword: '#c678dd', string: '#98c379', comment: '#5c6370' },
  ts: { keyword: '#c678dd', string: '#98c379', comment: '#5c6370' },
  py: { keyword: '#c678dd', string: '#98c379', comment: '#5c6370' },
  json: { keyword: '#e5c07b', string: '#98c379', comment: '#5c6370' },
  md: { keyword: '#61afef', string: '#98c379', comment: '#5c6370' },
  yaml: { keyword: '#e5c07b', string: '#98c379', comment: '#5c6370' },
  xml: { keyword: '#e06c75', string: '#98c379', comment: '#5c6370' },
  html: { keyword: '#e06c75', string: '#98c379', comment: '#5c6370' },
  css: { keyword: '#d19a66', string: '#98c379', comment: '#5c6370' },
  sh: { keyword: '#c678dd', string: '#98c379', comment: '#5c6370' },
  sql: { keyword: '#c678dd', string: '#98c379', comment: '#5c6370' },
};

export default function TextViewer({ url, fileName }: TextViewerProps) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lineCount, setLineCount] = useState(0);
  const [wordWrap, setWordWrap] = useState(true);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [fontSize, setFontSize] = useState(14);
  const preRef = useRef<HTMLPreElement>(null);

  // 获取文件扩展名
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  // 加载文本内容
  useEffect(() => {
    async function loadContent() {
      try {
        setLoading(true);
        const response = await fetch(url);
        if (!response.ok) throw new Error('加载失败');
        const text = await response.text();
        setContent(text);
        setLineCount(text.split('\n').length);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    }
    loadContent();
  }, [url]);

  // 字体大小控制
  const handleZoomIn = () => setFontSize(prev => Math.min(prev + 2, 28));
  const handleZoomOut = () => setFontSize(prev => Math.max(prev - 2, 10));

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <Loader2 className="animate-spin h-8 w-8 text-primary mx-auto mb-3" />
          <p className="text-muted-foreground">正在加载文件...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-96 text-destructive">
        <p>加载失败: {error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 bg-card border-b border-border">
        <div className="flex items-center space-x-3">
          <span className="text-sm text-muted-foreground">{lineCount} 行</span>
          <div className="w-px h-4 bg-secondary"></div>
          <button
            onClick={() => setShowLineNumbers(!showLineNumbers)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${showLineNumbers ? 'bg-primary text-white' : 'bg-secondary text-foreground'}`}
          >
            <Hash className="w-3 h-3" />
            行号
          </button>
          <button
            onClick={() => setWordWrap(!wordWrap)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${wordWrap ? 'bg-primary text-white' : 'bg-secondary text-foreground'}`}
          >
            <WrapText className="w-3 h-3" />
            自动换行
          </button>
        </div>
        <div className="flex items-center space-x-2">
          <button onClick={handleZoomOut} className="p-1 hover:bg-secondary rounded" title="缩小字体">
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs text-muted-foreground">{fontSize}px</span>
          <button onClick={handleZoomIn} className="p-1 hover:bg-secondary rounded" title="放大字体">
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 代码区 */}
      <div className="flex-1 overflow-auto bg-background">
        <div className="flex">
          {/* 行号列 */}
          {showLineNumbers && (
            <div className="flex-shrink-0 text-right pr-4 py-4 select-none border-r border-border bg-background/50">
              {Array.from({ length: lineCount }, (_, i) => (
                <div
                  key={i + 1}
                  className="text-muted-foreground leading-6"
                  style={{ fontSize: `${fontSize}px`, fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace' }}
                >
                  {i + 1}
                </div>
              ))}
            </div>
          )}

          {/* 内容区 */}
          <pre
            ref={preRef}
            className="flex-1 p-4 overflow-x-auto"
            style={{
              fontSize: `${fontSize}px`,
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
              whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
              wordBreak: wordWrap ? 'break-all' : 'normal',
              tabSize: 2,
            }}
          >
            <code className="text-foreground leading-6">{content}</code>
          </pre>
        </div>
      </div>

      {/* 底部信息 */}
      <div className="px-4 py-2 bg-card border-t border-border flex items-center justify-between text-xs text-muted-foreground">
        <span>{fileName} · {ext.toUpperCase()}</span>
        <span>{content.length.toLocaleString()} 字符 · UTF-8</span>
      </div>
    </div>
  );
}
