/**
 * About 设置页 —— 版本信息 + 自动更新检测
 *
 * 设计规范 (Spec §30):
 * - 版本号是比较明显的信息
 * - 进入该页面时自动检测有无可用新版本
 * - 发现新版本：提示下载，显示进度条，完成后退出安装
 */
import { useState, useEffect } from 'react';
import { Download, RefreshCw, Check, AlertCircle, Loader2, ExternalLink } from 'lucide-react';
import { Button, Section } from '../components/ui';
import type { UpdateStatus } from '../../preload/index';
import type { SysInfo } from './types';

export interface AboutSettingsProps {
  sysInfo: SysInfo | null;
}

/** 字节转换为 MB 字符串 */
function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export function AboutSettings({ sysInfo }: AboutSettingsProps) {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });

  useEffect(() => {
    // 订阅主进程推送的更新状态
    window.electronAPI.onUpdateStatus((s) => setStatus(s as UpdateStatus));

    // 进入页面时自动检测
    window.electronAPI.checkForUpdates().catch(() => {});

    return () => {
      window.electronAPI.removeAllListeners('event:update-status');
    };
  }, []);

  const handleDownload = () => {
    window.electronAPI.downloadUpdate().catch(() => {});
  };

  const handleInstall = () => {
    window.electronAPI.installUpdate();
  };

  const handleRetry = () => {
    window.electronAPI.checkForUpdates().catch(() => {});
  };

  const currentVersion = sysInfo?.appVersion || '1.0.0';

  return (
    <div>
      <header className="mb-6">
        <h2 className="text-2xl font-semibold text-foreground">关于</h2>
        <p className="mt-1 text-sm text-muted-foreground">应用与运行时信息</p>
      </header>

      {/* ===== 版本 + 更新 ===== */}
      <Section title="版本">
        <div className="flex items-baseline gap-3">
          <p className="text-2xl font-semibold text-foreground">v{currentVersion}</p>
          {status.state === 'not-available' && (
            <span className="text-xs text-muted-foreground">已是最新版本</span>
          )}
        </div>

        {/* 检测中 */}
        {status.state === 'checking' && (
          <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>正在检查更新...</span>
          </div>
        )}

        {/* 发现新版本 */}
        {status.state === 'available' && (
          <div className="mt-4 rounded-sm bg-surface-raised p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-foreground">
                  发现新版本 <span className="text-accent-text font-semibold">v{status.version}</span>
                </p>
                {status.releaseNotes && (
                  <p className="mt-1 max-w-md text-xs text-muted-foreground line-clamp-3">
                    {status.releaseNotes}
                  </p>
                )}
              </div>
              <Button variant="primary" onClick={handleDownload}>
                <Download className="size-3.5" />
                下载更新
              </Button>
            </div>
          </div>
        )}

        {/* 下载中 */}
        {status.state === 'downloading' && (
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">正在下载...</span>
              <span className="font-mono text-xs text-foreground">
                {formatMB(status.transferred)} MB / {formatMB(status.total)} MB
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-subtle">
              <div
                className="h-full rounded-full bg-accent-solid transition-all duration-200"
                style={{ width: `${Math.min(status.percent, 100)}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">{status.percent.toFixed(0)}% 完成</p>
          </div>
        )}

        {/* 下载完成，等待安装 */}
        {status.state === 'downloaded' && (
          <div className="mt-4 flex items-center justify-between rounded-sm bg-surface-raised p-4">
            <div className="flex items-center gap-2">
              <Check className="size-4 text-success" />
              <span className="text-sm text-foreground">
                v{status.version} 已下载完成，退出后将自动安装
              </span>
            </div>
            <Button variant="primary" onClick={handleInstall}>
              退出并安装
            </Button>
          </div>
        )}

        {/* 错误 */}
        {status.state === 'error' && (
          <div className="mt-4 flex items-center justify-between rounded-sm bg-surface-danger/10 p-4">
            <div className="flex items-center gap-2">
              <AlertCircle className="size-4 flex-shrink-0 text-destructive" />
              <span className="text-sm text-foreground">{status.message}</span>
            </div>
            <Button variant="secondary" onClick={handleRetry}>
              <RefreshCw className="size-3" />
              重试
            </Button>
          </div>
        )}
      </Section>

      {/* ===== 运行时 ===== */}
      <Section title="运行时">
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Electron</dt>
            <dd className="font-mono text-xs">{sysInfo?.electronVersion || '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Chromium</dt>
            <dd className="font-mono text-xs">{sysInfo?.chromeVersion || '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Node.js</dt>
            <dd className="font-mono text-xs">{sysInfo?.nodeVersion || '—'}</dd>
          </div>
        </dl>
      </Section>

      {/* ===== 系统 ===== */}
      <Section title="系统">
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">操作系统</dt>
            <dd className="text-xs">{sysInfo?.osVersion || '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">主机名</dt>
            <dd className="font-mono text-xs">{sysInfo?.hostname || '—'}</dd>
          </div>
        </dl>
      </Section>
    </div>
  );
}
