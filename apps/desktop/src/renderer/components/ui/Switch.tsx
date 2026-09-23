/**
 * Switch —— 统一开关原语
 *
 * 设计规范 (Spec §7):
 * - 尺寸: 44×24（与原 Toggle 一致）
 * - OFF: surface-subtle 底色
 * - ON:  accent 降饱和度（非高饱和 primary）
 * - thumb: 白色
 * - 无额外 border
 * - 支持 click / Space / focus / reduced-motion / disabled
 */
import { useId } from 'react';

export interface SwitchProps {
  checked: boolean;
  onChange: (val: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  id?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  id,
}: SwitchProps) {
  const reactId = useId();
  const switchId = id || `switch-${reactId}`;
  const labelId = `${switchId}-label`;

  return (
    <div className="flex items-center justify-between gap-4">
      {label && (
        <div id={labelId} className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          {description && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={label ? labelId : undefined}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={
          'relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-120 ' +
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-canvas ' +
          'disabled:pointer-events-none disabled:opacity-40 ' +
          (checked ? 'bg-accent-solid' : 'bg-surface-hover')
        }
      >
        <span
          className={
            'absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-120 ' +
            (checked ? 'translate-x-[22px]' : 'translate-x-0')
          }
        />
      </button>
    </div>
  );
}
