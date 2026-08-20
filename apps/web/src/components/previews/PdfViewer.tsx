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
        {/* 沙箱隔离：限制 iframe 内 blob: 内容的权限，防止非 PDF 文件访问父页面资源。
            allow-scripts 允许 PDF 查看器执行脚本；allow-same-origin 允许 Chrome 内置 PDF 扩展加载。
            生产环境应在服务端验证文件确实是 PDF（magic bytes）后再提供 blob: URL。 */}
        <iframe
          src={url}
          sandbox="allow-scripts allow-same-origin"
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
