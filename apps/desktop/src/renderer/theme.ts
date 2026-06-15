// ===== 主题切换 =====
// 调色板由 globals.css 的 CSS 变量定义（:root 暗色 / :root.light 亮色），
// 这里只负责在 <html> 上切换 .light 类。App 挂载时和设置保存成功后调用。
export type Theme = 'light' | 'dark';

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('light', theme === 'light');
}
