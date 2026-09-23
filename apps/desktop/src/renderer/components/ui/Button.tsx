/**
 * Button —— 统一按钮原语
 *
 * 设计规范 (Spec §10):
 * - primary:   实心 accent，仅用于 保存/启动/确认/完成
 * - secondary: 次级操作（刷新/选择目录/停止）
 * - ghost:     工具栏 / 辅助操作 / inline action，默认几乎无视觉重量
 * - danger:    默认 ghost/neutral，hover 时微红 surface，confirm 时红底
 * - icon:      纯图标按钮，最小 32×32
 *
 * 交互 (better-ui):
 * - hover 仅 background/text 单一变化
 * - 120ms 过渡，仅变换触发属性
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

const base =
  'inline-flex items-center justify-center gap-1.5 font-medium whitespace-nowrap ' +
  'rounded-sm transition-colors duration-120 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-canvas ' +
  'disabled:pointer-events-none disabled:opacity-40 ' +
  'select-none';

const variants: Record<ButtonVariant, string> = {
  // primary: 实心 accent —— 页面内只有一个
  primary:
    'bg-accent-solid text-primary-foreground ' +
    'hover:brightness-110 active:scale-[0.96]',
  // secondary: surface + text，低存在感
  secondary:
    'bg-surface-subtle text-secondary-foreground ' +
    'hover:bg-surface-hover',
  // ghost: 几乎透明，hover 才出现 surface
  ghost:
    'bg-transparent text-muted-foreground ' +
    'hover:bg-surface-hover hover:text-foreground',
  // danger: 默认 ghost，hover 淡红 surface
  danger:
    'bg-transparent text-muted-foreground ' +
    'hover:bg-surface-danger/10 hover:text-destructive',
  // icon: 纯图标，最小 32×32
  icon:
    'bg-transparent text-muted-foreground size-8 p-0 ' +
    'hover:bg-surface-hover hover:text-foreground',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-9 px-3.5 text-sm',
  lg: 'h-11 px-5 text-base',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', className = '', children, ...rest }, ref) => {
    const isIcon = variant === 'icon';
    const sizeClass = isIcon ? '' : sizes[size];

    return (
      <button
        ref={ref}
        className={`${base} ${variants[variant]} ${sizeClass} ${className}`.trim()}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

Button.displayName = 'Button';
