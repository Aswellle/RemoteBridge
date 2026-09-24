/**
 * Input —— 统一输入框原语
 *
 * 设计规范 (Spec §12):
 * - height: 36px, radius: 8px (radius-sm)
 * - padding: 10px 12px
 * - surface: subtle
 * - border: transparent（默认无边框）
 * - focus: accent ring + subtle accent border
 *
 * 原则: 默认不要边框，靠 focus ring 表达状态
 */
import { forwardRef, type InputHTMLAttributes } from 'react';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...rest }, ref) => (
    <input
      ref={ref}
      className={
        'h-9 w-full rounded-sm bg-surface-subtle px-3 py-2 text-sm text-foreground ' +
        // 占位符不再叠加 /60 透明度：实测 60% 时仅 3.1:1（亮色），再叠加禁用态
        // 透明度会低到 1.66:1。占位符常承载操作指引（如"请先选择一个客户端"），
        // 必须保持可读，禁用感由 surface + cursor 表达而非压低文字对比。
        'placeholder:text-muted-foreground ' +
        'border border-transparent ' +
        'transition-colors duration-120 ' +
        'focus:border-accent-border/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ' +
        'disabled:cursor-not-allowed disabled:border-border/40 disabled:bg-surface-subtle disabled:text-muted-foreground ' +
        className
      }
      {...rest}
    />
  ),
);

Input.displayName = 'Input';
