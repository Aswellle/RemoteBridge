import type { SecurityLog } from './api-types';

// ===== 安全日志事件类型 → 中文标签 =====
// satisfies 约束：新增/重命名 SecurityLog['eventType'] 的成员会在此处产生编译错误，
// 避免某个 eventType 缺少标签/颜色而静默回退到 `|| eventType` 的默认值。
export const EVENT_TYPE_LABELS = {
  AUTH_FAIL: '认证失败',
  BLOCKED_PATH: '路径访问被阻止',
  REVOKE: '会话吊销',
  PIN_EXPIRED: 'PIN 码过期',
  SESSION_CREATED: '会话创建',
  ACCESS_DOWNLOAD: '文件下载',
  ACCESS_PREVIEW: '文件预览',
  ACCESS: '文件访问',
} satisfies Record<SecurityLog['eventType'], string>;

// ===== 安全日志事件类型 → Tailwind 样式 =====
// 依赖 apps/desktop 和 apps/web 共用的 CSS 变量调色板
// (--destructive/--warning/--muted/--success，定义在各自的 globals.css)。
export const EVENT_TYPE_COLORS = {
  AUTH_FAIL: 'text-destructive bg-destructive/10',
  BLOCKED_PATH: 'text-orange-400 bg-orange-400/10',
  REVOKE: 'text-warning bg-yellow-400/10',
  PIN_EXPIRED: 'text-muted-foreground bg-muted/10',
  SESSION_CREATED: 'text-success bg-green-400/10',
  ACCESS_DOWNLOAD: 'text-blue-400 bg-blue-400/10',
  ACCESS_PREVIEW: 'text-blue-400 bg-blue-400/10',
  ACCESS: 'text-blue-400 bg-blue-400/10',
} satisfies Record<SecurityLog['eventType'], string>;
