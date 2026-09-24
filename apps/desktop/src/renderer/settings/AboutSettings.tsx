/**
 * About 设置页 —— 品牌信息 + 自动更新 + 外部链接
 *
 * 设计：
 * - 顶部：LOGO（应用图标）+ RemoteBridge 名称 + 版本 + 检查更新
 * - 检查到更新：右侧显眼下载按钮（带新版版本号）
 * - 底部：GitHub 仓库 + 更新日志链接按钮（系统浏览器打开）
 */
import { useState, useEffect } from 'react';
import {
  Download,
  RefreshCw,
  Check,
  AlertCircle,
  Loader2,
  ExternalLink,
  Github,
  ScrollText,
} from 'lucide-react';
import { Button, Section } from '../components/ui';
import type { UpdateStatus } from '../../preload/index';
import type { SysInfo } from './types';

const GITHUB_REPO_URL = 'https://github.com/Aswellle/RemoteBridge';
const CHANGELOG_URL = 'https://github.com/Aswellle/RemoteBridge/releases';

export interface AboutSettingsProps {
  sysInfo: SysInfo | null;
}

/** 字节转换为 MB 字符串 */
function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

// 图标在模块级缓存：进入"关于"页时 IPC 往返未完成前只能渲染兜底图标，
// 若每次挂载都重新请求就会反复闪现兜底图标（旧标识）。首帧即取缓存值。
let iconCache = '';
let iconPromise: Promise<string> | null = null;

function loadAppIcon(): Promise<string> {
  if (iconCache) return Promise.resolve(iconCache);
  // 预取发生在模块加载阶段，此时必须确认 preload 桥已就绪，否则会中断模块求值
  const api = window.electronAPI;
  if (typeof api?.getAppIcon !== 'function') return Promise.resolve('');
  if (!iconPromise) {
    iconPromise = api
      .getAppIcon()
      .then((url) => {
        iconCache = url || '';
        return iconCache;
      })
      .catch(() => '')
      .finally(() => {
        iconPromise = null;
      });
  }
  return iconPromise;
}

// 设置页模块加载时即预取图标：等用户切到"关于"时缓存已就绪，首次进入也不会
// 出现兜底标识闪现。
void loadAppIcon();

// 自动检查每个应用会话只触发一次：原先每次进入"关于"页都会发起检查，
// 短时间内反复挂载会连续打印 "Checking for update (already in progress)"，
// 既无意义又干扰日志。手动点击"检查更新"不受此限制。
let autoCheckDone = false;

export function AboutSettings({ sysInfo }: AboutSettingsProps) {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });
  const [iconUrl, setIconUrl] = useState(iconCache);

  useEffect(() => {
    window.electronAPI.onUpdateStatus((s) => setStatus(s as UpdateStatus));
    if (!autoCheckDone) {
      autoCheckDone = true;
      window.electronAPI.checkForUpdates().catch(() => {});
    } else {
      // 复用主进程已有状态，避免重复发起检查
      window.electronAPI.getUpdateStatus().then((s) => setStatus(s as UpdateStatus)).catch(() => {});
    }
    loadAppIcon().then(setIconUrl);
    return () => {
      window.electronAPI.removeAllListeners('event:update-status');
    };
  }, []);

  const handleDownload = () => window.electronAPI.downloadUpdate().catch(() => {});
  const handleInstall = () => window.electronAPI.installUpdate();
  const handleRetry = () => window.electronAPI.checkForUpdates().catch(() => {});
  const handleOpenGitHub = () => window.electronAPI.openExternal(GITHUB_REPO_URL);
  const handleOpenChangelog = () => window.electronAPI.openExternal(CHANGELOG_URL);

  const currentVersion = sysInfo?.appVersion || '1.0.0';

  return (
    <div>
      <header className="mb-6">
        <h2 className="text-2xl font-semibold text-foreground">关于</h2>
        <p className="mt-1 text-sm text-muted-foreground">应用信息与版本更新</p>
      </header>

      {/* ===== 品牌 + 更新卡片 ===== */}
      <div className="rounded-xl bg-surface-raised p-5">
        <div className="flex items-center justify-between gap-4">
          {/* 左侧：LOGO + 名称 + 版本 */}
          <div className="flex items-center gap-4">
            {/* LOGO 图标 */}
            {iconUrl ? (
              <img
                src={iconUrl}
                alt="RemoteBridge"
                className="size-14 rounded-xl"
              />
            ) : (
              <div className="flex size-14 items-center justify-center rounded-xl bg-accent-solid text-primary-foreground">
                <span className="text-xl font-bold">RB</span>
              </div>
            )}
            <div>
              <p className="text-lg font-semibold text-foreground">RemoteBridge</p>
              <p className="text-sm text-muted-foreground">桌面端 v{currentVersion}</p>
              {status.state === 'not-available' && (
                <p className="mt-0.5 text-xs text-success">已是最新版本</p>
              )}
              {status.state === 'checking' && (
                <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  正在检查更新...
                </p>
              )}
            </div>
          </div>

          {/* 右侧：操作区 */}
          <div className="flex flex-shrink-0 items-center gap-3">
            {/* 发现新版本 —— 显眼下载按钮 */}
            {status.state === 'available' && (
              <Button variant="primary" size="lg" onClick={handleDownload} className="gap-2 px-6">
                <Download className="size-4" />
                下载 v{status.version}
              </Button>
            )}

            {/* 下载中 */}
            {status.state === 'downloading' && (
              <div className="w-40 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">下载中</span>
                  <span className="font-mono text-foreground">{status.percent.toFixed(0)}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-subtle">
                  <div
                    className="h-full rounded-full bg-accent-solid transition-all duration-200"
                    style={{ width: `${Math.min(status.percent, 100)}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatMB(status.transferred)} / {formatMB(status.total)} MB
                </p>
              </div>
            )}

            {/* 下载完成 */}
            {status.state === 'downloaded' && (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 text-sm text-success">
                  <Check className="size-4" />
                  <span>v{status.version} 已就绪</span>
                </div>
                <Button variant="primary" onClick={handleInstall}>
                  退出并安装
                </Button>
              </div>
            )}

            {/* 错误 */}
            {status.state === 'error' && (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 text-sm text-destructive">
                  <AlertCircle className="size-4" />
                  <span className="max-w-48 truncate">{status.message}</span>
                </div>
                <Button variant="secondary" onClick={handleRetry}>
                  <RefreshCw className="size-3" />
                  重试
                </Button>
              </div>
            )}

            {/* 空闲 / 最新 —— 突出的检查更新按钮 */}
            {(status.state === 'idle' || status.state === 'not-available') && (
              <Button variant="primary" onClick={handleRetry}>
                <RefreshCw className="size-3.5" />
                检查更新
              </Button>
            )}
          </div>
        </div>

        {/* 新版发行说明 */}
        {status.state === 'available' && status.releaseNotes && (
          <div className="mt-4 rounded-sm bg-surface-subtle p-3">
            <p className="mb-1 text-xs font-medium text-foreground">更新内容</p>
            <p className="max-h-20 overflow-y-auto text-xs leading-relaxed text-muted-foreground">
              {status.releaseNotes}
            </p>
          </div>
        )}
      </div>

      {/* ===== 外部链接 ===== */}
      <div className="mt-4 flex gap-3">
        <button
          onClick={handleOpenGitHub}
          className="flex flex-1 items-center justify-center gap-2 rounded-sm bg-surface-raised px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
        >
          <Github className="size-4" />
          开源仓库
          <ExternalLink className="size-3 text-muted-foreground" />
        </button>
        <button
          onClick={handleOpenChangelog}
          className="flex flex-1 items-center justify-center gap-2 rounded-sm bg-surface-raised px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
        >
          <ScrollText className="size-4" />
          更新日志
          <ExternalLink className="size-3 text-muted-foreground" />
        </button>
      </div>

      {/* ===== 运行时 / 系统信息 ===== */}
      <div className="mt-6 grid grid-cols-2 gap-4">
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
            <div className="flex justify-between">
              <dt className="text-muted-foreground">平台</dt>
              <dd className="font-mono text-xs">
                {sysInfo ? `${getPlatformName(sysInfo.platform)} ${sysInfo.arch}` : '—'}
              </dd>
            </div>
          </dl>
        </Section>
      </div>
    </div>
  );
}

function getPlatformName(platform: string): string {
  const names: Record<string, string> = {
    win32: 'Windows',
    darwin: 'macOS',
    linux: 'Linux',
  };
  return names[platform] || platform;
}
