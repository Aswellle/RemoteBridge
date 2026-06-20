'use client';

import { useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, X, Loader2, AlertTriangle, Image, FileText, FileType, FolderOpen } from 'lucide-react';
import { getFileCategory } from '@remotebridge/shared';
import { usePreview } from '@/hooks/usePreview';
import { useAppStore } from '@/store/app-store';
import { logger } from '@/lib/logger';

// 按需加载预览组件：同一时间只会渲染其中一个，拆分后非激活类型不进入主 bundle
const ImageViewer = dynamic(() => import('@/components/previews/ImageViewer'), { ssr: false });
const TextViewer = dynamic(() => import('@/components/previews/TextViewer'), { ssr: false });
const PdfViewer = dynamic(() => import('@/components/previews/PdfViewer'), { ssr: false });
const UnsupportedViewer = dynamic(() => import('@/components/previews/UnsupportedViewer'), { ssr: false });

// ===== 预览页面 Props =====
interface FilePreviewPageProps {
  filePath: string;
  fileName: string;
  fileExtension: string;
  onClose: () => void;
}

export default function FilePreview({ filePath, fileName, fileExtension, onClose }: FilePreviewPageProps) {
  const { previewUrl, category, loading, error, requestPreview, clearPreview } = usePreview();

  // 判断文件类别（usePreview 返回的 category 来自服务器，本地兜底）
  const localCategory = getFileCategory(fileExtension);
  const effectiveCategory = category !== 'unknown' ? category : localCategory;

  // 请求预览（未知类型无需网络请求，直接展示 UnsupportedViewer）
  useEffect(() => {
    if (localCategory === 'unknown') {
      return () => { clearPreview(); };
    }
    requestPreview(filePath);
    return () => {
      clearPreview();
    };
  }, [filePath, requestPreview, clearPreview, localCategory]);

  // ESC 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // 下载文件
  const handleDownload = useCallback(() => {
    try {
      const { requestDownload } = useAppStore.getState();
      requestDownload(filePath);
    } catch (err) {
      logger.error('下载请求失败:', err);
    }
  }, [filePath]);

  const CategoryIcon = effectiveCategory === 'image' ? Image
    : effectiveCategory === 'text' ? FileText
    : effectiveCategory === 'pdf' ? FileType
    : FolderOpen;

  return (
    <AnimatePresence>
      {/* 遮罩层：不绑定 onClick，只有 × 按钮和 ESC 键可关闭 */}
      <motion.div
        className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        {/* 模态框：阻止冒泡，防止内容区点击透传到遮罩 */}
        <motion.div
          className="bg-background rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden"
          role="dialog"
          aria-modal="true"
          aria-label="文件预览"
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          transition={{ type: 'spring', stiffness: 350, damping: 30 }}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
        >
          {/* 标题栏 */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <div className="flex items-center min-w-0">
              <CategoryIcon className="w-5 h-5 mr-3 text-muted-foreground flex-shrink-0" />
              <h2 className="text-lg font-semibold text-foreground truncate">{fileName}</h2>
              <span className="ml-2 text-sm text-muted-foreground flex-shrink-0">.{fileExtension}</span>
            </div>
            <div className="flex items-center space-x-3 flex-shrink-0 ml-4">
              <button
                onClick={handleDownload}
                className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/90 text-white text-sm rounded-lg transition-colors"
              >
                <Download className="w-4 h-4" />
                下载
              </button>
              <button
                onClick={onClose}
                className="flex items-center gap-1.5 px-4 py-2 bg-secondary hover:bg-secondary/80 text-foreground text-sm rounded-lg transition-colors"
              >
                <X className="w-4 h-4" />
                关闭
              </button>
            </div>
          </div>

          {/* 预览内容区 */}
          <div className="flex-1 overflow-auto">
            {localCategory === 'unknown' ? (
              <UnsupportedViewer fileName={fileName} onDownload={handleDownload} />
            ) : loading ? (
              <div className="flex items-center justify-center h-96">
                <div className="text-center">
                  <Loader2 className="animate-spin h-10 w-10 text-primary mx-auto mb-4" />
                  <p className="text-muted-foreground">正在加载预览...</p>
                </div>
              </div>
            ) : error ? (
              <div className="flex items-center justify-center h-96">
                <div className="text-center text-destructive">
                  <AlertTriangle className="w-10 h-10 mx-auto mb-4" />
                  <p className="text-lg">{error}</p>
                  <button
                    onClick={handleDownload}
                    className="mt-4 px-6 py-2 bg-secondary hover:bg-secondary/80 text-foreground rounded-lg transition-colors"
                  >
                    直接下载文件
                  </button>
                </div>
              </div>
            ) : previewUrl ? (
              <div className="h-full">
                {effectiveCategory === 'image' && <ImageViewer url={previewUrl} fileName={fileName} />}
                {effectiveCategory === 'text' && <TextViewer url={previewUrl} fileName={fileName} />}
                {effectiveCategory === 'pdf' && <PdfViewer url={previewUrl} fileName={fileName} />}
              </div>
            ) : null}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
