/**
 * Appearance 设置页
 *
 * 设计规范 (Spec §25):
 * - 主题选择改为 Segmented Control: [ Dark | Light ]
 * - 选中项: subtle accent background + accent text
 * - 不要整块蓝色
 */
import { Section } from '../components/ui';
import { Moon, Sun } from 'lucide-react';

export interface AppearanceSettingsProps {
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
}

export function AppearanceSettings({ theme, onThemeChange }: AppearanceSettingsProps) {
  const options: { value: 'dark' | 'light'; label: string; icon: React.ReactNode }[] = [
    { value: 'dark', label: '暗色', icon: <Moon className="[&>svg]:size-[18px]" /> },
    { value: 'light', label: '亮色', icon: <Sun className="[&>svg]:size-[18px]" /> },
  ];

  return (
    <div>
      <header className="mb-6">
        <h2 className="text-2xl font-semibold text-foreground">外观</h2>
        <p className="mt-1 text-sm text-muted-foreground">切换应用主题</p>
      </header>

      <Section title="主题">
        <div
          className="inline-flex rounded-sm bg-surface-subtle p-0.5"
          role="tablist"
          aria-label="主题选择"
        >
          {options.map((opt) => {
            const isActive = theme === opt.value;
            return (
              <button
                key={opt.value}
                role="tab"
                aria-selected={isActive}
                onClick={() => onThemeChange(opt.value)}
                className={
                  'inline-flex items-center gap-2 rounded-sm px-4 py-2 text-sm transition-colors duration-120 ' +
                  (isActive
                    ? 'bg-accent-surface/10 font-medium text-accent-text'
                    : 'text-muted-foreground hover:text-foreground')
                }
              >
                {opt.icon}
                {opt.label}
              </button>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
