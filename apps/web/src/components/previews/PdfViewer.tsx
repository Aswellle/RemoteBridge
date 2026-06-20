'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

interface PdfViewerProps {
  url: string;
  fileName: string;
}

export default function PdfViewer({ url, fileName }: PdfViewerProps) {
  const [loading, setLoading] = useState(true);

  return (
    <div className="flex flex-col h-full">
      {/* PDF 容器：浏览器内置 PDF 查看器提供缩放、翻页、搜索等所有控件 */}
      <div className="flex-1 relative bg-background">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
            <div className="text-center">
              <Loader2 className="animate-spin h-8 w-8 text-primary mx-auto mb-3" />
              <p className="text-muted-foreground">正在加载 PDF...</p>
            </div>
          </div>
        )}
        <iframe
          src={url}
          className="w-full h-full border-0"
          onLoad={() => setLoading(false)}
          title={fileName}
          // P1-10: blob: URL 默认与本页同源。sandbox（不含 allow-same-origin）强制
          // 该 iframe 使用独立的不透明源——即使文件是伪装成 .pdf 的 HTML/JS，
          // 也无法读取本应用的 localStorage/cookie。浏览器内置 PDF 渲染器不受
          // sandbox 限制，仍可正常显示，其自带的缩放/翻页/搜索工具栏也完整可用。
          sandbox="allow-scripts"
        />
      </div>

      <div className="px-4 py-2 bg-card border-t border-border flex items-center justify-between text-xs text-muted-foreground">
        <span>{fileName}</span>
        <span>PDF 文档 · 使用浏览器内置阅读器（含缩放 / 翻页 / 搜索）</span>
      </div>
    </div>
  );
}
