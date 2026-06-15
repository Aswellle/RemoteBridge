'use client';

import { useState } from 'react';
import { Clock, Download, CheckCircle, XCircle, Loader2, Inbox, Eye, Trash2, Gauge, Timer } from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { formatFileSize } from '@remotebridge/shared';
import FilePreview from '@/components/previews/FilePreview';

// 下载状态唯一来源是 store.activeDownloads（由 download-manager 在流式下载时
// 回写真实进度/速度/ETA）。此组件只负责展示——之前这里自己挂 WS 监听、
// 用 127.0.0.1 原始地址触发下载、再用定时器模拟速度，三件事都已废弃。

type DownloadRecord = ReturnType<typeof useAppStore.getState>['activeDownloads'][0];

export default function DownloadPanel() {
  const { activeDownloads, clearCompletedDownloads } = useAppStore();
  const [previewFile, setPreviewFile] = useState<{
    path: string;
    name: string;
    extension: string;
  } | null>(null);

  // 预览：用 Host 上的原始文件路径走正规预览链路
  // （之前把 downloadUrl 当文件路径发给 Host，必然被拒绝）
  const handlePreview = (download: DownloadRecord) => {
    const ext = download.fileName.split('.').pop()?.toLowerCase() || '';
    setPreviewFile({
      path: download.filePath,
      name: download.fileName,
      extension: ext,
    });
  };

  // 获取状态图标
  const getStatusIcon = (status: DownloadRecord['status']) => {
    switch (status) {
      case 'pending': return <Clock className="w-4 h-4 text-yellow-400" />;
      case 'downloading': return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
      case 'completed': return <CheckCircle className="w-4 h-4 text-success" />;
      case 'error': return <XCircle className="w-4 h-4 text-destructive" />;
    }
  };

  const completedCount = activeDownloads.filter(d => d.status === 'completed').length;
  const activeCount = activeDownloads.filter(d => d.status === 'downloading' || d.status === 'pending').length;
  // 最新的排在最上面
  const downloads = [...activeDownloads].sort((a, b) => b.startedAt - a.startedAt);

  return (
    <div className="bg-card rounded-lg shadow-lg">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center space-x-2">
          <Download className="w-4 h-4 text-muted-foreground" />
          <h3 className="font-semibold text-foreground">下载管理</h3>
          {activeCount > 0 && (
            <span className="px-2 py-0.5 bg-primary text-white text-xs rounded-full">
              {activeCount}
            </span>
          )}
        </div>
        {completedCount > 0 && (
          <button
            onClick={clearCompletedDownloads}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            清空已完成
          </button>
        )}
      </div>

      {/* 下载列表 */}
      <div className="max-h-64 overflow-y-auto">
        {downloads.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Inbox className="w-8 h-8 mx-auto mb-1 text-muted-foreground" />
            <p className="text-sm">暂无下载任务</p>
            <p className="text-xs mt-1 text-muted-foreground">选择文件并点击下载以开始</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {downloads.map((download) => (
              <div
                key={download.id}
                className="px-4 py-3 hover:bg-secondary/50 transition-colors"
                aria-label={`下载: ${download.fileName}, ${download.status}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center min-w-0">
                    <span className="mr-2 flex-shrink-0">{getStatusIcon(download.status)}</span>
                    <span className="text-sm text-foreground truncate">{download.fileName}</span>
                  </div>
                  <div className="flex items-center space-x-2 flex-shrink-0 ml-2">
                    {download.status === 'completed' && (
                      <button
                        onClick={() => handlePreview(download)}
                        className="flex items-center gap-1 text-xs text-primary hover:text-primary/80"
                      >
                        <Eye className="w-3 h-3" />
                        预览
                      </button>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {download.fileSize > 0 ? formatFileSize(download.fileSize) : '-'}
                    </span>
                  </div>
                </div>

                {/* 进度条 */}
                {download.status === 'downloading' && (
                  <>
                    <div
                      className="w-full bg-secondary rounded-full h-1.5 mt-2"
                      role="progressbar"
                      aria-valuenow={download.progress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${download.fileName} 下载进度`}
                    >
                      <div
                        className="bg-primary h-1.5 rounded-full transition-all duration-300"
                        style={{ width: `${download.progress}%` }}
                      ></div>
                    </div>
                    {/* 实测速度与剩余时间 */}
                    <div className="flex items-center gap-3 mt-1.5">
                      {download.speed != null && download.speed > 0 && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Gauge className="w-3 h-3" />
                          {formatSpeed(download.speed)}
                        </span>
                      )}
                      {download.eta != null && download.eta > 0 && download.eta < 86400 && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Timer className="w-3 h-3" />
                          {formatEta(download.eta)}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground ml-auto">{download.progress}%</span>
                    </div>
                  </>
                )}

                {/* 错误信息 */}
                {download.status === 'error' && download.error && (
                  <p className="text-xs text-destructive mt-1">{download.error}</p>
                )}

                {/* 时间 */}
                <p className="text-xs text-muted-foreground mt-1">
                  {new Date(download.startedAt).toLocaleTimeString('zh-CN')}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 预览弹窗 */}
      {previewFile && (
        <FilePreview
          filePath={previewFile.path}
          fileName={previewFile.name}
          fileExtension={previewFile.extension}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  );
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  if (bytesPerSecond >= 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  }
  return `${Math.round(bytesPerSecond)} B/s`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${Math.floor(seconds / 3600)}时${Math.floor((seconds % 3600) / 60)}分`;
}
