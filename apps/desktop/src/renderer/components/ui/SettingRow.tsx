/**
 * SettingRow —— 设置行原语
 *
 * 设计规范 (Spec §23):
 * - 左侧 icon（muted）+ title + description
 * - 右侧 control 固定
 * - 行高至少 56px
 * - title 14px / medium，description 12-13px
 * - 无厚边框
 */
import type { ReactNode } from 'react';

export interface SettingRowProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  control: ReactNode;
  disabled?: boolean;
}

export function SettingRow({
  icon,
  title,
  description,
  control,
  disabled = false,
}: SettingRowProps) {
  return (
    <div
      className={
        'flex min-h-[56px] items-center justify-between gap-4 py-3 ' +
        (disabled ? 'opacity-40 pointer-events-none' : '')
      }
    >
      <div className="flex min-w-0 items-center gap-3">
        {icon && (
          <span className="flex-shrink-0 text-muted-foreground/70 [&>svg]:size-[18px]">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {description && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>
      <div className="flex-shrink-0">{control}</div>
    </div>
  );
}
