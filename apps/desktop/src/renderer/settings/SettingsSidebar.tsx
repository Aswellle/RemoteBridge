/**
 * Settings 左侧导航
 *
 * 设计规范 (Spec §20, §48, §49):
 * - 6 个分组: General / Appearance / Connection / Local Relay / File Handling / About
 * - 选中态明显但克制：accent surface (低透明) + accent text
 * - hover 仅 surface
 * - icon 默认 muted，active 时 accent
 * - 不要整行大蓝底
 */
import { Settings, Palette, Plug, Server, FolderOpen, Info } from 'lucide-react';
import type { NavItem, SettingsSectionId } from './types';

const NAV_ITEMS: (NavItem & { icon: React.ReactNode })[] = [
  { id: 'general', label: '通用', icon: <Settings className="[&>svg]:size-[18px]" /> },
  { id: 'appearance', label: '外观', icon: <Palette className="[&>svg]:size-[18px]" /> },
  { id: 'connection', label: '连接', icon: <Plug className="[&>svg]:size-[18px]" /> },
  { id: 'localRelay', label: '本地 Relay', icon: <Server className="[&>svg]:size-[18px]" /> },
  { id: 'fileHandling', label: '文件处理', icon: <FolderOpen className="[&>svg]:size-[18px]" /> },
  { id: 'about', label: '关于', icon: <Info className="[&>svg]:size-[18px]" /> },
];

export interface SettingsSidebarProps {
  active: SettingsSectionId;
  onChange: (id: SettingsSectionId) => void;
}

export function SettingsSidebar({ active, onChange }: SettingsSidebarProps) {
  return (
    <aside
      className="w-56 flex-shrink-0 flex flex-col gap-0.5 py-4"
      aria-label="设置导航"
      role="tablist"
    >
      <div className="px-4 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground/60">
        设置
      </div>
      {NAV_ITEMS.map((item) => {
        const isActive = active === item.id;
        return (
          <button
            key={item.id}
            role="tab"
            aria-selected={isActive}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onChange(item.id)}
            className={
              'relative flex items-center gap-3 rounded-sm px-4 py-2.5 text-sm transition-colors duration-120 ' +
              (isActive
                ? 'bg-accent-surface/8 font-medium text-accent-text'
                : 'font-normal text-muted-foreground hover:bg-surface-hover hover:text-foreground')
            }
          >
            {/* 活跃指示条 */}
            {isActive && (
              <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-accent-solid" />
            )}
            <span className={isActive ? 'text-accent-text' : 'text-muted-foreground/70'}>
              {item.icon}
            </span>
            <span>{item.label}</span>
          </button>
        );
      })}
    </aside>
  );
}
