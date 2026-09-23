/**
 * General 设置页
 *
 * 设计规范 (Spec §24):
 * - Startup: Launch at startup (Switch)
 * - Window:  Minimize to tray (Switch)
 * - 修改即生效（immediate mode）
 */
import { Section, SettingRow, Switch } from '../components/ui';
import { Monitor, PanelTop } from 'lucide-react';

export interface GeneralSettingsProps {
  autoStart: boolean;
  minimizeToTray: boolean;
  onAutoStartChange: (val: boolean) => void;
  onMinimizeChange: (val: boolean) => void;
}

export function GeneralSettings({
  autoStart,
  minimizeToTray,
  onAutoStartChange,
  onMinimizeChange,
}: GeneralSettingsProps) {
  return (
    <div>
      <header className="mb-6">
        <h2 className="text-2xl font-semibold text-foreground">通用</h2>
        <p className="mt-1 text-sm text-muted-foreground">应用启动与窗口行为</p>
      </header>

      <Section title="启动" description="应用启动时的行为">
        <SettingRow
          icon={<PanelTop />}
          title="开机自启"
          description="系统启动时自动运行 RemoteBridge"
          control={<Switch checked={autoStart} onChange={onAutoStartChange} />}
        />
      </Section>

      <Section title="窗口" description="窗口关闭行为">
        <SettingRow
          icon={<Monitor />}
          title="最小化到托盘"
          description="关闭窗口时隐藏到系统托盘而不是退出"
          control={<Switch checked={minimizeToTray} onChange={onMinimizeChange} />}
        />
      </Section>
    </div>
  );
}
