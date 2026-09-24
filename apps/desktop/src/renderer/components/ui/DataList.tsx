/**
 * DataList / DataRow —— 只读「标签 + 值」信息列表原语
 *
 * 设计规范（沿用 Spec §22/§23 的信息层级）：
 * - 用 <dl>/<dt>/<dd> 表达语义（标签与值的配对关系可被辅助技术读出）
 * - 标签 12px 次级色，值 13–14px 前景色；值可带一行 12px 补充说明
 * - 数值型值用 tabular-nums，避免刷新时数字宽度变化引起跳动
 * - 等宽值（主机名/路径/版本号）用 font-mono
 * - 长值不换行溢出：truncate + title 兜底，保证行高一致
 *
 * 供「连接状态」信息面板与侧栏系统信息等只读展示场景复用。
 */
import type { ReactNode } from 'react';

export interface DataListProps {
  children: ReactNode;
  className?: string;
}

export function DataList({ children, className = '' }: DataListProps) {
  // 行间距 8px（space-y-2）：与 16px+ 的区块间距形成 2× 以上的分组对比
  return <dl className={'space-y-2 ' + className}>{children}</dl>;
}

export interface DataRowProps {
  label: string;
  /** 主值：字符串或自定义节点（如状态点 + 文案） */
  value: ReactNode;
  /** 值下方的一行补充说明（12px 次级色） */
  hint?: ReactNode;
  /** 值使用等宽字体（主机名、路径、版本号） */
  mono?: boolean;
  /** 值使用表格数字（延迟、计数等会变化的数值） */
  numeric?: boolean;
  /** 悬停显示完整值（值可能被截断时必填） */
  title?: string;
}

export function DataRow({ label, value, hint, mono = false, numeric = false, title }: DataRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="flex-shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">
        <span
          className={
            'block truncate text-sm font-medium text-foreground ' +
            (mono ? 'font-mono text-[13px] ' : '') +
            (numeric ? 'tabular-nums' : '')
          }
          title={title}
        >
          {value}
        </span>
        {hint && (
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{hint}</span>
        )}
      </dd>
    </div>
  );
}
