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
          // Chrome 89+ 的内置 PDF 渲染器需要 allow-same-origin 才能工作（否则显示
          // "该页面已被 Chrome 屏蔽"）。blob: URL 已与本应用同源，allow-same-origin
          // 不会扩大攻击面：恶意 HTML 伪装成 PDF 在 allow-scripts 下已可执行脚本；
          // 内容始终来自经验证的 Host，且仅可访问本应用自身的 origin。
          sandbox="allow-scripts allow-same-origin"
        />
      </div>

      <div className="px-4 py-2 bg-card border-t border-border flex items-center justify-between text-xs text-muted-foreground">
        <span>{fileName}</span>
        <span>PDF 文档 · 使用浏览器内置阅读器（含缩放 / 翻页 / 搜索）</span>
      </div>
    </div>
  );
}
