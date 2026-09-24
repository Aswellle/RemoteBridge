/**
 * Settings 主框架 —— 状态编排 + 脏变更追踪 + 未保存提示
 *
 * 设计规范 (Spec §21, §31):
 * - 左侧导航 + 主内容区
 * - 主区域宽度 min(760px, available)
 * - 两类保存模式：
 *   Immediate: theme / minimizeToTray / autoStart —— 修改即生效
 *   Explicit:  relayUrl / relayApiUrl / uploadPaths / port —— 需点保存
 * - Explicit 变更后显示 sticky footer: [Discard] [Save]
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Moon,
  Sun,
  Check,
  X as XIcon,
  Play,
  Square,
  AlertCircle,
  Loader2,
  Info,
} from 'lucide-react';
import { applyTheme } from '../theme';
import { Button } from '../components/ui';
import { SettingsSidebar } from './SettingsSidebar';
import type {
  SettingsData,
  UploadPaths,
  SysInfo,
  LocalRelayState,
} from './types';
import { GeneralSettings } from './GeneralSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { ConnectionSettings } from './ConnectionSettings';
import { LocalRelaySettings } from './LocalRelaySettings';
import { FileHandlingSettings } from './FileHandlingSettings';
import { AboutSettings } from './AboutSettings';
import type { SettingsSectionId } from './types';

const INITIAL_SETTINGS: SettingsData = {
  relayUrl: 'ws://127.0.0.1:3002/ws',
  relayApiUrl: 'http://127.0.0.1:3002/api/v1',
  autoStart: false,
  minimizeToTray: true,
  theme: 'dark',
};

export default function SettingsShell() {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('general');
  const [isLoading, setIsLoading] = useState(true);

  // === 立即生效的设置 ===
  const [settings, setSettings] = useState<SettingsData>(INITIAL_SETTINGS);

  // === 显式保存的设置 (dirty tracking) ===
  const [draftRelayUrl, setDraftRelayUrl] = useState(settings.relayUrl);
  const [draftRelayApiUrl, setDraftRelayApiUrl] = useState(settings.relayApiUrl);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState('');

  // === 上传路径 ===
  const [uploadPaths, setUploadPaths] = useState<UploadPaths>({
    images: '', videos: '', documents: '', archives: '', markdown: '',
  });
  // 平台默认路径：用于在界面上标记"默认"状态并提供一键恢复默认
  const [uploadPathDefaults, setUploadPathDefaults] = useState<UploadPaths | null>(null);
  const [isSavingPaths, setIsSavingPaths] = useState(false);
  const [pathsSaveStatus, setPathsSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // === 系统信息 ===
  const [sysInfo, setSysInfo] = useState<SysInfo | null>(null);

  // === 本地 Relay ===
  const [lrStatus, setLrStatus] = useState<LocalRelayState>('stopped');
  const [lrPort, setLrPort] = useState(3002);
  const [lrAutoStart, setLrAutoStart] = useState(false);
  const [lrError, setLrError] = useState('');
  const [lrLogs, setLrLogs] = useState<string[]>([]);
  const [lrLoading, setLrLoading] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // ── 加载设置 ──
  useEffect(() => {
    async function load() {
      try {
        const data = await window.electronAPI.getSettings();
        setSettings(data);
        setDraftRelayUrl(data.relayUrl);
        setDraftRelayApiUrl(data.relayApiUrl);
      } catch (err) {
        console.error('加载设置失败:', err);
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, []);

  // ── 加载上传路径（含平台默认值，用于回显真实落盘路径） ──
  useEffect(() => {
    async function load() {
      try {
        const result = await window.electronAPI.getUploadPaths();
        if (result.success && result.data) {
          setUploadPaths(result.data.paths);
          setUploadPathDefaults(result.data.defaults);
        }
      } catch {}
    }
    load();
  }, []);

  // ── 系统信息 ──
  useEffect(() => {
    window.electronAPI.getSystemInfo().then(setSysInfo).catch(() => {});
  }, []);

  // ── 本地 Relay 初始状态 ──
  useEffect(() => {
    Promise.all([
      window.electronAPI.localRelayGetState(),
      window.electronAPI.localRelayGetConfig(),
    ]).then(([state, cfg]) => {
      setLrStatus(state.status as LocalRelayState);
      setLrError(state.error || '');
      setLrLogs(state.logs);
      setLrPort(cfg.port);
      setLrAutoStart(cfg.autoStart);
    }).catch(() => {});
  }, []);

  // ── 本地 Relay 事件订阅 ──
  useEffect(() => {
    window.electronAPI.onLocalRelayStatus(({ status, error }) => {
      setLrStatus(status as LocalRelayState);
      setLrError(error || '');
      setLrLoading(false);
    });
    window.electronAPI.onLocalRelayLog((line) => {
      setLrLogs((prev) => {
        const next = [...prev, line];
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    });
    return () => {
      window.electronAPI.removeAllListeners('event:local-relay-status');
      window.electronAPI.removeAllListeners('event:local-relay-log');
    };
  }, []);

  // ── 日志自动滚动 ──
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [lrLogs]);

  // ── 脏判断: relay 地址是否被修改 ──
  const hasConnectionDraft =
    draftRelayUrl !== settings.relayUrl || draftRelayApiUrl !== settings.relayApiUrl;

  // ── 立即生效: 主题 ──
  const handleThemeChange = useCallback((theme: 'light' | 'dark') => {
    setSettings((prev) => ({ ...prev, theme }));
    applyTheme(theme);
    // 主题也持久化，但不阻塞
    window.electronAPI.saveSettings({ ...settings, theme }).catch(() => {});
  }, [settings]);

  // ── 立即生效: 开关 ──
  const handleImmediateToggle = useCallback(
    (key: 'autoStart' | 'minimizeToTray', val: boolean) => {
      setSettings((prev) => {
        const next = { ...prev, [key]: val };
        // 立即持久化
        window.electronAPI.saveSettings(next).catch(() => {});
        return next;
      });
    },
    [],
  );

  // ── 显式保存: 连接地址 ──
  const handleSaveConnection = useCallback(async () => {
    if (!hasConnectionDraft) return;
    setIsSaving(true);
    setSaveStatus('idle');
    try {
      const result = await window.electronAPI.saveSettings({
        ...settings,
        relayUrl: draftRelayUrl,
        relayApiUrl: draftRelayApiUrl,
      });
      if (result.success) {
        setSettings((prev) => ({
          ...prev,
          relayUrl: draftRelayUrl,
          relayApiUrl: draftRelayApiUrl,
        }));
        setSaveStatus('success');
        setStatusMessage(result.reconnected ? '已保存并重新连接 Relay' : '已保存');
        setTimeout(() => setSaveStatus('idle'), 3000);
      } else {
        setSaveStatus('error');
        setStatusMessage(result.error || '保存失败');
      }
    } catch {
      setSaveStatus('error');
      setStatusMessage('保存失败');
    } finally {
      setIsSaving(false);
    }
  }, [settings, draftRelayUrl, draftRelayApiUrl, hasConnectionDraft]);

  const handleDiscardConnection = useCallback(() => {
    setDraftRelayUrl(settings.relayUrl);
    setDraftRelayApiUrl(settings.relayApiUrl);
  }, [settings]);

  // ── 上传路径 ──
  const handleSelectPath = useCallback(async (category: keyof UploadPaths) => {
    const dir = await window.electronAPI.selectDirectory();
    if (dir) setUploadPaths((prev) => ({ ...prev, [category]: dir }));
  }, []);

  // ── 在文件管理器中打开该类别的保存目录 ──
  const handleOpenUploadPath = useCallback(
    async (category: keyof UploadPaths) => {
      // 输入框为空时回落到平台默认路径，保证按钮始终指向真实目录
      const target = uploadPaths[category] || uploadPathDefaults?.[category];
      if (!target) return;
      await window.electronAPI.openPath(target);
    },
    [uploadPaths, uploadPathDefaults],
  );

  // ── 单个类别恢复为平台默认路径 ──
  const handleResetUploadPath = useCallback(
    (category: keyof UploadPaths) => {
      if (!uploadPathDefaults) return;
      setUploadPaths((prev) => ({ ...prev, [category]: uploadPathDefaults[category] }));
    },
    [uploadPathDefaults],
  );

  const handleSaveUploadPaths = useCallback(async () => {
    setIsSavingPaths(true);
    setPathsSaveStatus('idle');
    try {
      // 空输入回落到平台默认路径，避免把空字符串写进配置导致后续落盘失败
      const normalized = { ...uploadPaths };
      if (uploadPathDefaults) {
        (Object.keys(normalized) as (keyof UploadPaths)[]).forEach((cat) => {
          if (!normalized[cat]?.trim()) normalized[cat] = uploadPathDefaults[cat];
        });
      }
      const result = await window.electronAPI.setUploadPaths(normalized);
      setPathsSaveStatus(result.success ? 'success' : 'error');
      if (result.success) {
        setUploadPaths(normalized);
        setTimeout(() => setPathsSaveStatus('idle'), 3000);
      }
    } catch {
      setPathsSaveStatus('error');
    } finally {
      setIsSavingPaths(false);
    }
  }, [uploadPaths, uploadPathDefaults]);

  // ── 本地 Relay 操作 ──
  const handleLrStart = useCallback(async () => {
    setLrLoading(true);
    const res = await window.electronAPI.localRelayStart(lrPort);
    if (!res.success) { setLrError(res.error || ''); setLrLoading(false); }
  }, [lrPort]);

  const handleLrStop = useCallback(async () => {
    setLrLoading(true);
    await window.electronAPI.localRelayStop();
    setLrLoading(false);
  }, []);

  const handleLrAutoStart = useCallback(async (val: boolean) => {
    setLrAutoStart(val);
    await window.electronAPI.localRelaySetConfig({ autoStart: val });
  }, []);

  const handleLrPortSave = useCallback(async () => {
    await window.electronAPI.localRelaySetConfig({ port: lrPort });
  }, [lrPort]);

  const handleFillLocalRelayUrls = useCallback(() => {
    const url = `ws://127.0.0.1:${lrPort}/ws`;
    const api = `http://127.0.0.1:${lrPort}/api/v1`;
    setDraftRelayUrl(url);
    setDraftRelayApiUrl(api);
  }, [lrPort]);

  // ── 检测地址是否指向本地但未启动 ──
  const configUrlPointsToLocal =
    lrStatus === 'stopped' &&
    (draftRelayUrl.includes(`127.0.0.1:${lrPort}`) ||
      draftRelayUrl.includes(`localhost:${lrPort}`));

  if (isLoading) {
    return (
      <div className="flex h-full">
        <aside className="w-56 flex-shrink-0 p-4">
          <div className="space-y-2">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded-sm bg-surface-subtle" />
            ))}
          </div>
        </aside>
        <main className="flex-1 p-6">
          <div className="mb-4 h-7 w-40 animate-pulse rounded bg-surface-subtle" />
          <div className="space-y-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-sm bg-surface-subtle" />
            ))}
          </div>
        </main>
      </div>
    );
  }

  const connectionFooterVisible = activeSection === 'connection' && hasConnectionDraft;
  const pathFooterVisible = activeSection === 'fileHandling';

  return (
    <div className="flex h-full min-h-0">
      <SettingsSidebar active={activeSection} onChange={setActiveSection} />

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full min-w-0 max-w-[760px] px-6 py-6">
          {activeSection === 'general' && (
            <GeneralSettings
              autoStart={settings.autoStart}
              minimizeToTray={settings.minimizeToTray}
              onAutoStartChange={(v) => handleImmediateToggle('autoStart', v)}
              onMinimizeChange={(v) => handleImmediateToggle('minimizeToTray', v)}
            />
          )}

          {activeSection === 'appearance' && (
            <AppearanceSettings
              theme={settings.theme}
              onThemeChange={handleThemeChange}
            />
          )}

          {activeSection === 'connection' && (
            <ConnectionSettings
              relayUrl={draftRelayUrl}
              relayApiUrl={draftRelayApiUrl}
              onRelayUrlChange={setDraftRelayUrl}
              onRelayApiUrlChange={setDraftRelayApiUrl}
              lrStatus={lrStatus}
              lrPort={lrPort}
              configUrlPointsToLocal={configUrlPointsToLocal}
              hasDraft={hasConnectionDraft}
              isSaving={isSaving}
              saveStatus={saveStatus}
              statusMessage={statusMessage}
              onSave={handleSaveConnection}
              onDiscard={handleDiscardConnection}
              onFillLocal={handleFillLocalRelayUrls}
            />
          )}

          {activeSection === 'localRelay' && (
            <LocalRelaySettings
              status={lrStatus}
              port={lrPort}
              autoStart={lrAutoStart}
              error={lrError}
              logs={lrLogs}
              logRef={logContainerRef}
              loading={lrLoading}
              onPortChange={setLrPort}
              onPortSave={handleLrPortSave}
              onAutoStart={handleLrAutoStart}
              onStart={handleLrStart}
              onStop={handleLrStop}
            />
          )}

          {activeSection === 'fileHandling' && (
            <FileHandlingSettings
              paths={uploadPaths}
              defaults={uploadPathDefaults}
              onPathsChange={setUploadPaths}
              onSelectPath={handleSelectPath}
              onOpenPath={handleOpenUploadPath}
              onResetPath={handleResetUploadPath}
              isSaving={isSavingPaths}
              saveStatus={pathsSaveStatus}
              onSave={handleSaveUploadPaths}
            />
          )}

          {activeSection === 'about' && (
            <AboutSettings sysInfo={sysInfo} />
          )}
        </div>

        {/* ── 未保存变更 sticky footer ── */}
        {connectionFooterVisible && (
          <div className="sticky bottom-0 flex items-center justify-between border-t border-[color-mix(in_srgb,currentColor_8%,transparent)] bg-surface-canvas/95 px-6 py-3 backdrop-blur">
            <span className="text-sm text-muted-foreground">有未保存的更改</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={handleDiscardConnection}>丢弃</Button>
              <Button variant="primary" onClick={handleSaveConnection} disabled={isSaving}>
                {isSaving ? '保存中...' : '保存'}
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
