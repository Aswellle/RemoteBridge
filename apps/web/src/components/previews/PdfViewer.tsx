'use client';

import { useState, useRef } from 'react';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize, Loader2 } from 'lucide-react';

interface PdfViewerProps {
  url: string;
  fileName: string;
}

export default function PdfViewer({ url, fileName }: PdfViewerProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [loading, setLoading] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // 缩放控制
  const handleZoomIn = () => setScale(prev => Math.min(prev + 0.25, 3));
  const handleZoomOut = () => setScale(prev => Math.max(prev - 0.25, 0.5));
  const handleZoomFit = () => setScale(1.0);

  // 页面导航
  const handlePrevPage = () => setCurrentPage(prev => Math.max(prev - 1, 1));
  const handleNextPage = () => setCurrentPage(prev => Math.min(prev + 1, totalPages));

  // iframe 加载完成
  const handleLoad = () => {
    setLoading(false);
    // 尝试获取总页数（跨域可能失败）
    try {
      const iframe = iframeRef.current;
      if (iframe?.contentDocument) {
        // 同源时可以访问
        setTotalPages(1); // 降级处理
      }
    } catch {
      setTotalPages(1);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 bg-card border-b border-border">
        <div className="flex items-center space-x-3">
          <button
            onClick={handlePrevPage}
            disabled={currentPage <= 1}
            className="p-1 bg-secondary hover:bg-secondary/80 disabled:opacity-50 rounded text-sm"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm text-foreground">
            {currentPage} / {totalPages || '?'}
          </span>
          <button
            onClick={handleNextPage}
            disabled={totalPages > 0 && currentPage >= totalPages}
            className="p-1 bg-secondary hover:bg-secondary/80 disabled:opacity-50 rounded text-sm"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center space-x-2">
          <button onClick={handleZoomOut} className="p-1.5 hover:bg-secondary rounded text-sm" title="缩小">
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-sm text-foreground font-mono min-w-[50px] text-center">
            {Math.round(scale * 100)}%
          </span>
          <button onClick={handleZoomIn} className="p-1.5 hover:bg-secondary rounded text-sm" title="放大">
            <ZoomIn className="w-4 h-4" />
          </button>
          <div className="w-px h-5 bg-secondary mx-1"></div>
          <button onClick={handleZoomFit} className="p-1.5 hover:bg-secondary rounded text-sm" title="适应窗口">
            <Maximize className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* PDF 容器 */}
      <div className="flex-1 overflow-auto bg-background flex items-center justify-center">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <Loader2 className="animate-spin h-8 w-8 text-primary mx-auto mb-3" />
              <p className="text-muted-foreground">正在加载 PDF...</p>
            </div>
          </div>
        )}

        <iframe
          ref={iframeRef}
          src={`${url}#page=${currentPage}&zoom=${Math.round(scale * 100)}`}
          className="w-full h-full border-0"
          style={{
            transform: `scale(${scale})`,
            transformOrigin: 'center center',
          }}
          onLoad={handleLoad}
          title={fileName}
          // P1-10: blob: URL 默认与本页同源。sandbox（不含 allow-same-origin）强制
          // 该 iframe 使用一个独立的不透明源 —— 即使文件实际是伪装成 .pdf 的
          // HTML/JS,也无法读取本应用的 localStorage/cookie。浏览器内置 PDF
          // 渲染器不受 sandbox 限制,仍可正常显示。
          sandbox="allow-scripts"
        />
      </div>

      {/* 底部信息 */}
      <div className="px-4 py-2 bg-card border-t border-border flex items-center justify-between text-xs text-muted-foreground">
        <span>{fileName}</span>
        <span>PDF 文档 · 使用内置 PDF 阅读器</span>
      </div>
    </div>
  );
}
