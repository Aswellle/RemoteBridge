'use client';

import { useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useFileStream } from '@/hooks/useFileStream';
import { getFileCategory } from '@remotebridge/shared';
import ImageViewer from '@/components/previews/ImageViewer';
import VideoViewer from '@/components/previews/VideoViewer';
import SheetViewer from '@/components/previews/SheetViewer';
import DocViewer from '@/components/previews/DocViewer';
import PdfViewer from '@/components/previews/PdfViewer';
import { Loader2, AlertTriangle } from 'lucide-react';

function PreviewContent() {
  const params = useSearchParams();
  const filePath = params.get('path');
  const fileName = params.get('name') || 'file';
  const fileExt = params.get('ext') || '';
  const size = Number(params.get('size') || 0);
  const category = getFileCategory(fileExt);

  const { blobUrl, loading, error, progress, fetchFile } = useFileStream(filePath);

  useEffect(() => {
    if (filePath) fetchFile();
  }, [filePath, fetchFile]);

  if (!filePath) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-center text-muted-foreground">
          <AlertTriangle className="w-12 h-12 mx-auto mb-3" />
          <p>缺少文件路径参数</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-center">
          <Loader2 className="animate-spin h-10 w-10 text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">正在加载 {fileName}...</p>
          {progress > 0 && (
            <div className="mt-3 w-48 mx-auto">
              <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
              </div>
              <p className="text-xs text-muted-foreground mt-1">{progress}%</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-center text-destructive">
          <AlertTriangle className="w-12 h-12 mx-auto mb-3" />
          <p className="text-lg">{error}</p>
          <p className="text-sm text-muted-foreground mt-2">{fileName}</p>
        </div>
      </div>
    );
  }

  if (!blobUrl) {
    return null;
  }

  // 根据类别渲染对应查看器
  switch (category) {
    case 'image':
      return <ImageViewer url={blobUrl} fileName={fileName} fullscreen />;
    case 'video':
      return <VideoViewer url={blobUrl} fileName={fileName} />;
    case 'spreadsheet':
      return <SheetViewer url={blobUrl} fileName={fileName} fileExt={fileExt} />;
    case 'text':
    case 'document':
      return <DocViewer url={blobUrl} fileName={fileName} fileExt={fileExt} />;
    case 'pdf':
      return <PdfViewer url={blobUrl} fileName={fileName} />;
    default:
      return (
        <div className="flex items-center justify-center h-screen bg-background">
          <div className="text-center text-muted-foreground">
            <AlertTriangle className="w-12 h-12 mx-auto mb-3" />
            <p>不支持预览此文件类型</p>
            <p className="text-sm mt-1">{fileName}</p>
            <a href={blobUrl} download={fileName}
              className="mt-4 inline-block px-6 py-2 bg-primary text-white rounded-lg hover:bg-primary/90">
              下载文件
            </a>
          </div>
        </div>
      );
  }
}

export default function PreviewPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen bg-background">
        <Loader2 className="animate-spin h-10 w-10 text-primary" />
      </div>
    }>
      <PreviewContent />
    </Suspense>
  );
}
