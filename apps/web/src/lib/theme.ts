// ===== 主题切换（web） =====
// 调色板由 globals.css 定义（:root 暗色 / :root.light 亮色），这里只负责
// 在 <html> 上切换 .light 类并持久化到 localStorage。
// 各入口页面（连接页 / dashboard layout）挂载时调用 initTheme()，
// 设置页切换时调用 applyTheme()。
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'theme';

export function getSavedTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  if (typeof window === 'undefined') return;
  document.documentElement.classList.toggle('light', theme === 'light');
  localStorage.setItem(STORAGE_KEY, theme);
}

export function initTheme(): void {
  applyTheme(getSavedTheme());
}
