/**
 * 跨平台系统字体栈 —— 零网络依赖、原生渲染、Pro 级排版。
 *
 * 排序即优先级：每层都是该平台/语言下视觉与度量最优的系统字体，
 * 末位回退到通用族 + 全彩色 emoji，保证任何设备都不出现 tofu。
 *
 * 参考体系：Apple HIG、Microsoft Fluent、IBM Plex、Linear / Vercel / GitHub 字体栈。
 */

/** 无衬线正文 / UI 字体栈 */
export const FONT_SANS = [
  // Apple 平台（SF Pro 系列）
  '-apple-system',
  'BlinkMacSystemFont',
  '"SF Pro Text"',
  '"SF Pro Display"',
  // Windows（现代可变字体 + 经典）
  '"Segoe UI Variable"',
  '"Segoe UI"',
  // Android / ChromeOS / 通用 web
  'Roboto',
  '"Helvetica Neue"',
  'Arial',
  // Linux
  '"Noto Sans"',
  '"Liberation Sans"',
  // Apple 中文（macOS / iOS）
  '"PingFang SC"',
  '"PingFang TC"',
  // Windows 中文
  '"Microsoft YaHei"',
  '"Microsoft JhengHei"',
  // 旧 macOS 中文
  '"Hiragino Sans GB"',
  // Linux 中文
  '"WenQuanYi Micro Hei"',
  // 通用族兜底
  'sans-serif',
  // 彩色 emoji（跟随系统原生表情）
  '"Apple Color Emoji"',
  '"Segoe UI Emoji"',
  '"Segoe UI Symbol"',
  '"Noto Color Emoji"',
].join(', ');

/** 等宽字体栈（用于 PIN、主机名、IP、代码、日志） */
export const FONT_MONO = [
  // macOS
  '"SF Mono"',
  '"SFMono-Regular"',
  // 开发者字体（若已安装）
  '"JetBrains Mono"',
  '"Fira Code"',
  '"Cascadia Code"',
  // 系统通用等宽
  'ui-monospace',
  // 经典回退
  'Menlo',
  'Monaco',
  'Consolas',
  '"Liberation Mono"',
  '"Courier New"',
  // 通用族兜底
  'monospace',
].join(', ');

/** 行高与字距的排版令牌（与字体栈配套使用） */
export const TYPOGRAPHY = {
  // 正文：紧凑中文行高 + 微字距，提升信息密度
  body: { lineHeight: '1.6', letterSpacing: '0.01em' },
  // 标题：更紧行距，略负字距增强凝聚力
  heading: { lineHeight: '1.2', letterSpacing: '-0.01em' },
  // 数据（PIN / 主机名）：宽松等宽，易辨识
  mono: { lineHeight: '1.5', letterSpacing: '0.02em' },
} as const;
