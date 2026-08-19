'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { ZoomIn, ZoomOut, Maximize, RotateCcw, RotateCw, Loader2, AlertTriangle, Info, Play, Pause, SkipBack, SkipForward } from 'lucide-react';

interface ImageViewerProps {
  url: string;
  fileName: string;
  fullscreen?: boolean;
}

export default function ImageViewer({ url, fileName, fullscreen = false }: ImageViewerProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [imgLoading, setImgLoading] = useState(true);
  const [imgError, setImgError] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Touch gesture state (refs to avoid re-renders during gesture)
  const touchStateRef = useRef({
    initialDistance: 0,
    initialScale: 1,
    lastTapTime: 0,
    isPinching: false,
    isPanning: false,
    panStartX: 0,
    panStartY: 0,
    posStartX: 0,
    posStartY: 0,
  });

  // 图片加载完成
  const handleLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
    setImgLoading(false);
    setImgError(false);
  };

  const handleError = () => {
    setImgLoading(false);
    setImgError(true);
  };
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  // 获取文件大小（仅对 blob: 与可 fetch 的 URL 有效）
  useEffect(() => {
    let cancelled = false;
    setFileSize(null);
    const fetchSize = async () => {
      try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        if (!cancelled) setFileSize(blob.size);
      } catch {
        // 无法获取大小时静默忽略
      }
    };
    fetchSize();
    return () => { cancelled = true; };
  }, [url]);


  // 缩放控制
  const handleZoomIn = () => setScale(prev => Math.min(prev + 0.25, 5));
  const handleZoomOut = () => setScale(prev => Math.max(prev - 0.25, 0.1));
  const handleZoomFit = () => {
    if (!containerRef.current || !naturalSize.width) return;
    const container = containerRef.current.getBoundingClientRect();
    const scaleX = (container.width - 40) / naturalSize.width;
    const scaleY = (container.height - 40) / naturalSize.height;
    setScale(Math.min(scaleX, scaleY, 1));
    setPosition({ x: 0, y: 0 });
  };
  const handleZoomOriginal = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  // 旋转控制
  const handleRotateLeft = () => setRotation(prev => prev - 90);
  const handleRotateRight = () => setRotation(prev => prev + 90);

  // 拖拽
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    setPosition({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  }, [isDragging, dragStart]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // 滚轮缩放：原生非 passive 监听，确保 preventDefault 有效（React 合成 onWheel 在 passive 模式下无效）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setScale(prev => Math.max(0.1, Math.min(5, prev + delta)));
    };
    container.addEventListener('wheel', handler, { passive: false });
    return () => container.removeEventListener('wheel', handler);
  }, []);

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') handleZoomIn();
      else if (e.key === '-') handleZoomOut();
      else if (e.key === '0') handleZoomOriginal();
      else if (e.key === 'f') handleZoomFit();
      else if (e.key === 'r' && !e.ctrlKey) handleRotateRight();
      else if (e.key === 'i') setShowInfo(s => !s);
      else if (e.key === 'Escape' && fullscreen) setShowInfo(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Touch gestures: pinch-to-zoom, single-finger pan, double-tap
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const getDistance = (t1: Touch, t2: Touch) =>
      Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

    const handleTouchStart = (e: TouchEvent) => {
      const ts = touchStateRef.current;

      if (e.touches.length === 2) {
        // Pinch start
        e.preventDefault();
        ts.isPinching = true;
        ts.isPanning = false;
        ts.initialDistance = getDistance(e.touches[0], e.touches[1]);
        setScale(prev => {
          ts.initialScale = prev;
          return prev;
        });
      } else if (e.touches.length === 1) {
        const now = Date.now();
        // Double-tap detection
        if (now - ts.lastTapTime < 300) {
          e.preventDefault();
          // Toggle between fit and 2x
          setScale(prev => {
            if (prev > 1.01) {
              setPosition({ x: 0, y: 0 });
              return 1;
            }
            return 2;
          });
          ts.lastTapTime = 0;
          return;
        }
        ts.lastTapTime = now;

        // Single-finger pan (only when zoomed in)
        setScale(currentScale => {
          if (currentScale > 1.01) {
            e.preventDefault();
            ts.isPanning = true;
            ts.panStartX = e.touches[0].clientX;
            ts.panStartY = e.touches[0].clientY;
            setPosition(prev => {
              ts.posStartX = prev.x;
              ts.posStartY = prev.y;
              return prev;
            });
          }
          return currentScale;
        });
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      const ts = touchStateRef.current;

      if (ts.isPinching && e.touches.length === 2) {
        e.preventDefault();
        const currentDistance = getDistance(e.touches[0], e.touches[1]);
        const ratio = currentDistance / ts.initialDistance;
        const newScale = Math.max(0.1, Math.min(10, ts.initialScale * ratio));
        setScale(newScale);
      } else if (ts.isPanning && e.touches.length === 1) {
        e.preventDefault();
        const dx = e.touches[0].clientX - ts.panStartX;
        const dy = e.touches[0].clientY - ts.panStartY;
        setPosition({
          x: ts.posStartX + dx,
          y: ts.posStartY + dy,
        });
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      const ts = touchStateRef.current;
      if (e.touches.length < 2) {
        ts.isPinching = false;
      }
      if (e.touches.length === 0) {
        ts.isPanning = false;
      }
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: false });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: false });

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, []);

  const outerClass = fullscreen
    ? 'flex flex-col h-screen w-screen fixed inset-0 z-50 bg-background'
    : 'flex flex-col h-full';

  const displayedWidth = Math.round(naturalSize.width * scale);
  const displayedHeight = Math.round(naturalSize.height * scale);

  return (
    <div className={outerClass}>
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 bg-card border-b border-border shrink-0">
        <div className="flex items-center space-x-2">
          <button onClick={handleZoomOut} className="p-1.5 hover:bg-secondary rounded" title="缩小 (-)">
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-sm text-foreground font-mono min-w-[60px] text-center">
            {Math.round(scale * 100)}%
          </span>
          <button onClick={handleZoomIn} className="p-1.5 hover:bg-secondary rounded" title="放大 (+)">
            <ZoomIn className="w-4 h-4" />
          </button>
          <div className="w-px h-5 bg-secondary mx-1"></div>
          <button onClick={handleZoomFit} className="p-1.5 hover:bg-secondary rounded" title="适应窗口 (F)">
            <Maximize className="w-4 h-4" />
          </button>
          <button onClick={handleZoomOriginal} className="p-1.5 hover:bg-secondary rounded text-xs font-mono" title="原始大小 (0)">
            1:1
          </button>
          <div className="w-px h-5 bg-secondary mx-1"></div>
          <button onClick={handleRotateLeft} className="p-1.5 hover:bg-secondary rounded" title="逆时针旋转">
            <RotateCcw className="w-4 h-4" />
          </button>
          <button onClick={handleRotateRight} className="p-1.5 hover:bg-secondary rounded" title="顺时针旋转 (R)">
            <RotateCw className="w-4 h-4" />
          </button>
          <div className="w-px h-5 bg-secondary mx-1"></div>
          {/* 幻灯片控制：单图时禁用 */}
          <button onClick={() => {}} disabled className="p-1.5 rounded opacity-40 cursor-not-allowed" title="上一张（仅多图）">
            <SkipBack className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsPlaying(p => !p)}
            disabled
            className="p-1.5 rounded opacity-40 cursor-not-allowed"
            title="播放幻灯片（仅多图）"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
          <button onClick={() => {}} disabled className="p-1.5 rounded opacity-40 cursor-not-allowed" title="下一张（仅多图）">
            <SkipForward className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setShowInfo(s => !s)}
            className={`p-1.5 rounded ${showInfo ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'}`}
            title="图像信息 (I)"
          >
            <Info className="w-4 h-4" />
          </button>
          <span className="text-xs text-muted-foreground">
            {displayedWidth} × {displayedHeight}px
            {naturalSize.width ? ` (原 ${naturalSize.width} × ${naturalSize.height})` : ''}
          </span>
        </div>
      </div>


      {/* 图片容器 */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden bg-background relative flex items-center justify-center cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
      >
        {/* 加载占位 */}
        {imgLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
            <div className="text-center">
              <Loader2 className="animate-spin h-8 w-8 text-primary mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">加载图片中...</p>
            </div>
          </div>
        )}
        {/* 加载失败 */}
        {imgError && (
          <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
            <div className="text-center text-destructive">
              <AlertTriangle className="w-8 h-8 mx-auto mb-2" />
              <p className="text-sm">图片加载失败</p>
            </div>
          </div>
        )}
        {/* 故意使用 <img> 而非 next/image（P3-14，04a-B16）：url 是 blob: 对象 URL 或
            relay 代理 URL，next/image 的优化器不支持 blob: 来源；本组件的缩放/旋转/
            拖拽/手势逻辑还需要直接持有 <img> DOM 引用（imgRef）和 CSS transform 控制，
            next/image 的 <span>+<img> 包装结构会妨碍这一点。 */}
        <img
          ref={imgRef}
          src={url}
          alt={fileName}
          onLoad={handleLoad}
          onError={handleError}
          className="max-w-none select-none"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotation}deg)`,
            transition: isDragging ? 'none' : 'transform 0.15s ease',
            opacity: imgLoading || imgError ? 0 : 1,
          }}
          draggable={false}
        />
        {/* EXIF / 图像信息面板 */}
        {showInfo && naturalSize.width > 0 && (
          <div className="absolute top-4 right-4 z-20 bg-card/95 backdrop-blur border border-border rounded-lg p-4 min-w-[220px] shadow-lg">
            <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center">
              <Info className="w-4 h-4 mr-1.5" /> 图像信息
            </h3>
            <dl className="space-y-1.5 text-xs">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">文件名</dt>
                <dd className="text-foreground truncate ml-3 max-w-[140px]" title={fileName}>{fileName}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">原始尺寸</dt>
                <dd className="text-foreground font-mono">{naturalSize.width} × {naturalSize.height}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">显示尺寸</dt>
                <dd className="text-foreground font-mono">{displayedWidth} × {displayedHeight}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">缩放比例</dt>
                <dd className="text-foreground font-mono">{Math.round(scale * 100)}%</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">旋转角度</dt>
                <dd className="text-foreground font-mono">{rotation % 360}°</dd>
              </div>
              {fileSize !== null && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">文件大小</dt>
                  <dd className="text-foreground font-mono">{formatFileSize(fileSize)}</dd>
                </div>
              )}
            </dl>
          </div>
        )}

      </div>

      {/* 底部信息栏 */}
      <div className="px-4 py-2 bg-card border-t border-border flex items-center justify-between text-xs text-muted-foreground">
        <span>{fileName}</span>
        <span>拖拽移动 · 滚轮缩放 · 双指缩放 · 双击缩放 · R 旋转 · F 适应 · 0 原始大小 · I 信息</span>
      </div>
    </div>
  );
}
