'use client';

import { useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle,
  XCircle,
  Loader2,
  X,
  Trash2,
  HardDrive,
} from 'lucide-react';
import { useTransferStore } from '@/store/transfer-store';
import { formatFileSize } from '@remotebridge/shared';

// ===== Transfer Center Component =====

export default function TransferCenter() {
  const { transfers, stats, cancelTransfer, clearCompleted } = useTransferStore();
  const [activeTab, setActiveTab] = useState<'all' | 'downloading' | 'uploading' | 'completed'>('all');

  const transferList = Object.values(transfers);

  const filtered = transferList.filter((t) => {
    if (activeTab === 'all') return true;
    if (activeTab === 'downloading') return t.kind === 'download' && (t.status === 'pending' || t.status === 'streaming');
    if (activeTab === 'uploading') return t.kind === 'upload' && (t.status === 'pending' || t.status === 'streaming');
    if (activeTab === 'completed') return t.status === 'completed' || t.status === 'cancelled' || t.status === 'error';
    return true;
  });

  // Latest first
  const sorted = [...filtered].sort((a, b) => b.startedAt - a.startedAt);

  const activeCount = stats.activeTransfers;
  const completedCount = stats.completedTransfers;

  return (
    <div className="bg-card rounded-lg shadow-lg flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HardDrive className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-foreground">传输中心</h3>
          {activeCount > 0 && (
            <span className="px-2 py-0.5 text-xs bg-primary/10 text-primary rounded-full">
              {activeCount} 进行中
            </span>
          )}
        </div>
        {completedCount > 0 && (
          <button
            onClick={clearCompleted}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
            title="清除已完成"
          >
            <Trash2 className="w-3 h-3" />
            清除已完成
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="px-4 py-2 border-b border-border flex gap-1 overflow-x-auto">
        {([
          { key: 'all', label: '全部', count: stats.totalTransfers },
          { key: 'downloading', label: '下载', count: transferList.filter((t) => t.kind === 'download' && (t.status === 'streaming' || t.status === 'pending')).length },
          { key: 'uploading', label: '上传', count: transferList.filter((t) => t.kind === 'upload' && (t.status === 'streaming' || t.status === 'pending')).length },
          { key: 'completed', label: '已完成', count: completedCount },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1 text-xs rounded-full transition-colors whitespace-nowrap ${
              activeTab === tab.key
                ? 'bg-primary text-white'
                : 'bg-secondary text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
            {tab.count > 0 && (
              <span className="ml-1 opacity-75">({tab.count})</span>
            )}
          </button>
        ))}
      </div>

      {/* Transfer List */}
      <div className="flex-1 overflow-auto">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
            <HardDrive className="w-12 h-12 mb-2 opacity-30" />
            <p className="text-sm">暂无传输任务</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {sorted.map((transfer) => (
              <TransferItem
                key={transfer.id}
                transfer={transfer}
                onCancel={() => cancelTransfer(transfer.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer Stats */}
      {stats.totalTransfers > 0 && (
        <div className="px-4 py-2 border-t border-border text-xs text-muted-foreground flex items-center justify-between">
          <span>总传输: {formatFileSize(stats.totalBytesTransferred)}</span>
          {stats.averageSpeed > 0 && (
            <span>平均速度: {formatSpeed(stats.averageSpeed)}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ===== Transfer Item Component =====

interface TransferItemProps {
  transfer: {
    id: string;
    kind: 'download' | 'upload' | 'preview';
    fileName: string;
    fileSize: number;
    transferredBytes: number;
    status: string;
    progress: number;
    speed: number;
    eta: number;
    error?: string;
    startedAt: number;
  };
  onCancel: () => void;
}

function TransferItem({ transfer, onCancel }: TransferItemProps) {
  const isDownloading = transfer.kind === 'download';
  const isActive = transfer.status === 'streaming' || transfer.status === 'pending';
  const isCompleted = transfer.status === 'completed';
  const isError = transfer.status === 'error';
  const isCancelled = transfer.status === 'cancelled';

  return (
    <div className="px-4 py-3 hover:bg-secondary/30 transition-colors">
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className="mt-0.5">
          {isDownloading ? (
            <ArrowDownToLine className="w-5 h-5 text-blue-500" />
          ) : (
            <ArrowUpFromLine className="w-5 h-5 text-green-500" />
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-foreground truncate">{transfer.fileName}</span>
            <div className="flex items-center gap-1 shrink-0">
              {isActive && (
                <button
                  onClick={onCancel}
                  className="p-1 hover:bg-secondary rounded text-muted-foreground hover:text-destructive transition-colors"
                  title="取消"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              {isCompleted && <CheckCircle className="w-4 h-4 text-green-500" />}
              {isError && <XCircle className="w-4 h-4 text-destructive" />}
              {isCancelled && <XCircle className="w-4 h-4 text-muted-foreground" />}
            </div>
          </div>

          {/* Progress bar */}
          {isActive && (
            <div className="mt-2">
              <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{ width: `${transfer.progress}%` }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {formatFileSize(transfer.transferredBytes)} / {formatFileSize(transfer.fileSize)}
                </span>
                <span className="flex items-center gap-2">
                  {transfer.speed > 0 && <span>{formatSpeed(transfer.speed)}</span>}
                  {transfer.eta > 0 && transfer.eta < 3600 && (
                    <span>剩余 {formatEta(transfer.eta)}</span>
                  )}
                  <span>{transfer.progress}%</span>
                </span>
              </div>
            </div>
          )}

          {/* Status text */}
          {!isActive && (
            <div className="mt-1 text-xs text-muted-foreground">
              {isCompleted && <span>已完成 · {formatFileSize(transfer.fileSize)}</span>}
              {isError && <span className="text-destructive">{transfer.error || '传输失败'}</span>}
              {isCancelled && <span>已取消</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ===== Helpers =====

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
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}
