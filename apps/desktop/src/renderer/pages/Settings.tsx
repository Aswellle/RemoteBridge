import { useState, useEffect } from 'react';
import { Moon, Sun, Check, X as XIcon } from 'lucide-react';
import { applyTheme } from '../theme';

interface SettingsData {
  relayUrl: string;
  relayApiUrl: string;
  autoStart: boolean;
  minimizeToTray: boolean;
  theme: 'light' | 'dark';
}

interface UploadPaths {
  images: string;
  videos: string;
  documents: string;
  archives: string;
  markdown: string;
}

const CATEGORY_LABELS: Record<keyof UploadPaths, string> = {
  images: '图片',
  videos: '视频',
  documents: '文档 (PDF / Word / Excel / PPT)',
  archives: '压缩包',
  markdown: 'Markdown',
};

interface SysInfo {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  osVersion: string;
  platform: string;
  hostname: string;
}

export default function SettingsPage() {
  const [sysInfo, setSysInfo] = useState<SysInfo | null>(null);

  useEffect(() => {
    window.electronAPI.getSystemInfo().then(setSysInfo).catch(() => {});
  }, []);

  const [settings, setSettings] = useState<SettingsData>({
    relayUrl: 'ws://127.0.0.1:3001/ws',
    relayApiUrl: 'http://127.0.0.1:3001/api/v1',
    autoStart: false,
    minimizeToTray: true,
    theme: 'dark',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState('');

  const [uploadPaths, setUploadPaths] = useState<UploadPaths>({
    images: '',
    videos: '',
    documents: '',
    archives: '',
    markdown: '',
  });
  const [isSavingPaths, setIsSavingPaths] = useState(false);
  const [pathsSaveStatus, setPathsSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // 加载设置
  useEffect(() => {
    async function loadSettings() {
      try {
        const data = await window.electronAPI.getSettings();
        setSettings(data);
      } catch (err) {
        console.error('加载设置失败:', err);
      } finally {
        setIsLoading(false);
      }
    }
    loadSettings();
  }, []);

  // 加载文件保存路径
  useEffect(() => {
    async function loadUploadPaths() {
      try {
        const result = await window.electronAPI.getUploadPaths();
        if (result.success && result.data) {
          setUploadPaths(result.data);
        }
      } catch (err) {
        console.error('加载文件保存路径失败:', err);
      }
    }
    loadUploadPaths();
  }, []);

  // 为某个类别选择目录
  const handleSelectPath = async (category: keyof UploadPaths) => {
    try {
      const dir = await window.electronAPI.selectDirectory();
      if (dir) {
        setUploadPaths((prev) => ({ ...prev, [category]: dir }));
      }
    } catch (err) {
      console.error('选择目录失败:', err);
    }
  };

  // 保存文件接收路径
  const handleSaveUploadPaths = async () => {
    setIsSavingPaths(true);
    setPathsSaveStatus('idle');
    try {
      const result = await window.electronAPI.setUploadPaths(uploadPaths);
      setPathsSaveStatus(result.success ? 'success' : 'error');
      if (result.success) setTimeout(() => setPathsSaveStatus('idle'), 3000);
    } catch {
      setPathsSaveStatus('error');
    } finally {
      setIsSavingPaths(false);
    }
  };

  // 保存设置（保存即生效：主题立即切换，Relay 地址变更由主进程热重连）
  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus('idle');
    try {
      const result = await window.electronAPI.saveSettings(settings);
      if (result.success) {
        applyTheme(settings.theme);
        if (result.reconnectError) {
          setSaveStatus('error');
          setStatusMessage(`已保存，但连接新 Relay 失败: ${result.reconnectError}`);
        } else {
          setSaveStatus('success');
          setStatusMessage(result.reconnected ? '已保存并重新连接 Relay' : '已保存');
          setTimeout(() => setSaveStatus('idle'), 3000);
        }
      } else {
        setSaveStatus('error');
        setStatusMessage(result.error || '保存失败');
      }
    } catch (err) {
      setSaveStatus('error');
      setStatusMessage('保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  // Toggle 组件
  function Toggle({
    checked,
    onChange,
    label,
    description,
  }: {
    checked: boolean;
    onChange: (val: boolean) => void;
    label: string;
    description?: string;
  }) {
    return (
      <div className="flex items-center justify-between py-3">
        <div>
          <p className="text-sm font-medium">{label}</p>
          {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        </div>
        <button
          onClick={() => onChange(!checked)}
          role="switch"
          aria-checked={checked}
          className={`relative w-11 h-6 rounded-full transition-colors ${
            checked ? 'bg-primary' : 'bg-secondary'
          }`}
        >
          <div
            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
              checked ? 'translate-x-5.5 left-0.5' : 'left-0.5'
            }`}
            style={{ transform: checked ? 'translateX(22px)' : 'translateX(0)' }}
          />
        </button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-8">
        <h2 className="text-2xl font-semibold mb-6">设置</h2>
        <div className="space-y-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="animate-pulse bg-secondary rounded h-16 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-semibold mb-6">设置</h2>

      {/* Relay 服务器配置 */}
      <div className="bg-card rounded-xl p-6 border border-border/50 mb-4">
        <h3 className="text-lg font-semibold mb-4">Relay 服务器</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-muted-foreground mb-1">WebSocket URL</label>
            <input
              type="text"
              value={settings.relayUrl}
              onChange={(e) => setSettings({ ...settings, relayUrl: e.target.value })}
              className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary font-mono"
              placeholder="ws://localhost:3001/ws"
            />
          </div>

          <div>
            <label className="block text-sm text-muted-foreground mb-1">API URL</label>
            <input
              type="text"
              value={settings.relayApiUrl}
              onChange={(e) => setSettings({ ...settings, relayApiUrl: e.target.value })}
              className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary font-mono"
              placeholder="http://localhost:3001/api/v1"
            />
          </div>
        </div>
      </div>

      {/* 通用设置 */}
      <div className="bg-card rounded-xl p-6 border border-border/50 mb-4">
        <h3 className="text-lg font-semibold mb-4">通用</h3>

        <div className="divide-y divide-border">
          <Toggle
            checked={settings.autoStart}
            onChange={(val) => setSettings({ ...settings, autoStart: val })}
            label="开机自启"
            description="系统启动时自动运行 RemoteBridge"
          />

          <Toggle
            checked={settings.minimizeToTray}
            onChange={(val) => setSettings({ ...settings, minimizeToTray: val })}
            label="最小化到托盘"
            description="关闭窗口时隐藏到系统托盘而不是退出"
          />

          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-medium">主题</p>
              <p className="text-xs text-muted-foreground mt-0.5">切换亮色/暗色主题</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { setSettings({ ...settings, theme: 'dark' }); applyTheme('dark'); }}
                className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                  settings.theme === 'dark'
                    ? 'bg-primary text-white'
                    : 'bg-secondary text-muted-foreground hover:bg-secondary'
                }`}
              >
                <Moon className="w-3.5 h-3.5 inline mr-1" />暗色
              </button>
              <button
                onClick={() => { setSettings({ ...settings, theme: 'light' }); applyTheme('light'); }}
                className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                  settings.theme === 'light'
                    ? 'bg-primary text-white'
                    : 'bg-secondary text-muted-foreground hover:bg-secondary'
                }`}
              >
                <Sun className="w-3.5 h-3.5 inline mr-1" />亮色
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 文件接收路径 */}
      <div className="bg-card rounded-xl p-6 border border-border/50 mb-4">
        <h3 className="text-lg font-semibold mb-1">文件接收路径</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Web 端发送的文件将按类型自动存入对应目录。未修改时使用平台默认路径。
        </p>

        <div className="space-y-3">
          {(Object.keys(CATEGORY_LABELS) as (keyof UploadPaths)[]).map((cat) => (
            <div key={cat}>
              <label className="block text-sm text-muted-foreground mb-1">
                {CATEGORY_LABELS[cat]}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={uploadPaths[cat]}
                  onChange={(e) => setUploadPaths((prev) => ({ ...prev, [cat]: e.target.value }))}
                  className="flex-1 px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                  placeholder="（使用默认路径）"
                />
                <button
                  onClick={() => handleSelectPath(cat)}
                  className="px-3 py-2 bg-card border border-border hover:border-primary/60 hover:text-primary rounded-lg text-sm text-foreground transition-colors whitespace-nowrap"
                >
                  选择…
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 mt-4">
          <button
            onClick={handleSaveUploadPaths}
            disabled={isSavingPaths}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${
              isSavingPaths ? 'bg-secondary cursor-not-allowed' : 'bg-primary hover:bg-primary/90'
            }`}
          >
            {isSavingPaths ? '保存中...' : '保存路径'}
          </button>
          {pathsSaveStatus === 'success' && (
            <span className="flex items-center gap-1 text-sm text-success"><Check className="w-4 h-4" />已保存</span>
          )}
          {pathsSaveStatus === 'error' && (
            <span className="flex items-center gap-1 text-sm text-destructive"><XIcon className="w-4 h-4" />保存失败</span>
          )}
        </div>
      </div>

      {/* 关于 */}
      <div className="bg-card rounded-xl p-6 border border-border/50 mb-4">
        <h3 className="text-lg font-semibold mb-4">关于</h3>
        <div className="space-y-2.5 text-sm">
          {[
            { label: '应用版本', value: sysInfo?.appVersion },
            { label: 'Electron', value: sysInfo?.electronVersion },
            { label: 'Node.js', value: sysInfo?.nodeVersion },
            { label: 'Chromium', value: sysInfo?.chromeVersion },
            { label: '系统', value: sysInfo?.osVersion },
            { label: '主机名', value: sysInfo?.hostname },
          ].map(({ label, value }) => (
            <div key={label} className="flex items-center justify-between">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-mono text-xs bg-secondary px-2 py-0.5 rounded">
                {value || '—'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 保存按钮 */}
      <div className="flex items-center gap-3 mt-6">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className={`px-6 py-2.5 rounded-lg text-sm font-medium transition-all ${
            isSaving
              ? 'bg-secondary cursor-not-allowed'
              : 'bg-primary hover:bg-primary/90'
          }`}
        >
          {isSaving ? '保存中...' : '保存设置'}
        </button>

        {saveStatus === 'success' && (
          <span className="flex items-center gap-1 text-sm text-success"><Check className="w-4 h-4" />{statusMessage || '已保存'}</span>
        )}
        {saveStatus === 'error' && (
          <span className="flex items-center gap-1 text-sm text-destructive"><XIcon className="w-4 h-4" />{statusMessage || '保存失败'}</span>
        )}
      </div>
    </div>
  );
}
