/**
 * Divider —— 分割线原语
 *
 * 设计规范 (Spec §5.4):
 * - height: 1px
 * - background: color-mix(in srgb, currentColor 8%, transparent) —— 极低对比
 * - 不要高对比横线 / 双线 / 渐变线
 */
export function Divider({ className = '' }: { className?: string }) {
  return (
    <div
      role="separator"
      className={
        'h-px w-full ' +
        "bg-[color-mix(in_srgb,currentColor_8%,transparent)] " +
        'text-foreground/10 ' +
        className
      }
    />
  );
}
