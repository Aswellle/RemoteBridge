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
        {/* Chrome 的内置 PDF 查看器以浏览器扩展形式实现，任何 sandbox 属性都会
            阻止该扩展加载，导致"该页面已被 Chrome 屏蔽"。此处不加 sandbox：
            内容来自用户自己的 Host，经过令牌鉴权；blob: URL 天然同源，
            无外部来源污染风险。 */}
        <iframe
          src={url}
          className="w-full h-full border-0"
          onLoad={() => setLoading(false)}
          title={fileName}
        />
      </div>

      <div className="px-4 py-2 bg-card border-t border-border flex items-center justify-between text-xs text-muted-foreground">
        <span>{fileName}</span>
        <span>PDF 文档 · 使用浏览器内置阅读器（含缩放 / 翻页 / 搜索）</span>
      </div>
    </div>
  );
}
