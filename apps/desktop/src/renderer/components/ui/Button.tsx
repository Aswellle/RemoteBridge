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

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'icon';
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
  // 禁用态不再整体降透明度：opacity-40 会让标签实测低至 1.32:1（亮色，primary），
  // 文字几乎不可读。改为各变体显式给出禁用时的 surface + 文字色（见下方 disabled:*）。
  'disabled:pointer-events-none ' +
  'select-none';

const variants: Record<ButtonVariant, string> = {
  // primary: 实心 accent —— 页面内只有一个
  // 禁用态改为"描边 + raised 底 + 次级文字"：既保持可读（亮色 8.9:1），
  // 又与输入框等 subtle 填充面区分开，不会糊成一片而看不出是按钮
  primary:
    'bg-accent-solid text-primary-foreground ' +
    'hover:brightness-110 active:scale-[0.96] ' +
    'disabled:border disabled:border-border/60 disabled:bg-surface-raised disabled:text-muted-foreground disabled:hover:brightness-100',
  // secondary: surface + text，低存在感
  secondary:
    'bg-surface-subtle text-secondary-foreground ' +
    'hover:bg-surface-hover ' +
    'disabled:text-muted-foreground/70',
  // outline: 可见描边 + surface，用于次级操作（刷新、行内操作）以区别于纯文字
  outline:
    'border border-border/60 bg-surface-raised text-foreground ' +
    'hover:border-border hover:bg-surface-hover active:scale-[0.96] ' +
    'disabled:border-transparent disabled:bg-surface-subtle disabled:text-muted-foreground/70',
  // ghost: 几乎透明，hover 才出现 surface
  ghost:
    'bg-transparent text-muted-foreground ' +
    'hover:bg-surface-hover hover:text-foreground ' +
    'disabled:text-muted-foreground/60',
  // danger: 可见的破坏性描边（静息态即可辨识），hover 才填充淡红
  danger:
    'border border-destructive/50 bg-transparent text-destructive ' +
    'hover:border-destructive/70 hover:bg-surface-danger/15 active:scale-[0.96] ' +
    'disabled:border-transparent disabled:text-muted-foreground/60',
  // icon: 纯图标，最小 32×32
  icon:
    'bg-transparent text-muted-foreground size-8 p-0 ' +
    'hover:bg-surface-hover hover:text-foreground ' +
    'disabled:text-muted-foreground/50',
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
