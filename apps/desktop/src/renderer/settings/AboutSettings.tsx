/**
 * About 设置页
 *
 * 设计规范 (Spec §30):
 * - 版本号可成为比较明显的信息
 * - 仅真正技术性标识使用 mono
 * - 分组: Version / Runtime / System
 */
import { Section } from '../components/ui';
import type { SysInfo } from './types';

export interface AboutSettingsProps {
  sysInfo: SysInfo | null;
}

export function AboutSettings({ sysInfo }: AboutSettingsProps) {
  return (
    <div>
      <header className="mb-6">
        <h2 className="text-2xl font-semibold text-foreground">关于</h2>
        <p className="mt-1 text-sm text-muted-foreground">应用与运行时信息</p>
      </header>

      <Section title="版本">
        <p className="text-2xl font-semibold text-foreground">
          {sysInfo?.appVersion || '—'}
        </p>
      </Section>

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
        </dl>
      </Section>
    </div>
  );
}
