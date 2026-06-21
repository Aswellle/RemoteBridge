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
  AUTH_FAIL:       'text-red-700    bg-red-100    dark:text-red-400    dark:bg-red-900/30',
  BLOCKED_PATH:    'text-orange-700 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/30',
  REVOKE:          'text-yellow-700 bg-yellow-100 dark:text-yellow-400 dark:bg-yellow-900/30',
  PIN_EXPIRED:     'text-slate-600  bg-slate-100  dark:text-slate-400  dark:bg-slate-700/40',
  SESSION_CREATED: 'text-green-700  bg-green-100  dark:text-green-400  dark:bg-green-900/30',
  ACCESS_DOWNLOAD: 'text-blue-700   bg-blue-100   dark:text-blue-400   dark:bg-blue-900/30',
  ACCESS_PREVIEW:  'text-violet-700 bg-violet-100 dark:text-violet-400 dark:bg-violet-900/30',
  ACCESS:          'text-cyan-700   bg-cyan-100   dark:text-cyan-400   dark:bg-cyan-900/30',
} satisfies Record<SecurityLog['eventType'], string>;
