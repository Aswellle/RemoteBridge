/**
 * 文件工具模块
 * 文件类型判断、大小格式化等工具函数
 */

// ===== 可预览文件类型 =====
export const PREVIEWABLE_TYPES = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff'],
  text: [
    'txt', 'md', 'json', 'yaml', 'yml', 'xml', 'csv', 'log', 'ini',
    'ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h',
    'html', 'css', 'scss', 'less',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'sql', 'graphql', 'toml',
    'dockerfile', 'makefile', 'env', 'gitignore', 'editorconfig',
  ],
  pdf: ['pdf'],
} as const;

// ===== 文件类型判断 =====
export function getFileCategory(extension: string): 'image' | 'text' | 'pdf' | 'unknown' {
  const ext = extension.toLowerCase();

  if ((PREVIEWABLE_TYPES.image as unknown as string[]).includes(ext)) return 'image';
  if ((PREVIEWABLE_TYPES.text as unknown as string[]).includes(ext)) return 'text';
  if ((PREVIEWABLE_TYPES.pdf as unknown as string[]).includes(ext)) return 'pdf';

  return 'unknown';
}

export function isPreviewableFile(extension: string): boolean {
  return getFileCategory(extension) !== 'unknown';
}

// ===== 文件大小格式化 =====
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${units[i]}`;
}

// ===== 文件图标映射 =====
export function getFileIcon(extension: string): string {
  const ext = extension.toLowerCase();
  const category = getFileCategory(ext);

  switch (category) {
    case 'image': return '🖼️';
    case 'text': return '📄';
    case 'pdf': return '📕';
    default: return '📁';
  }
}

// ===== 路径工具 =====
export function getParentPath(filePath: string): string | null {
  const parent = filePath.replace(/[/\\][^/\\]+$/, '');
  return parent !== filePath ? parent : null;
}

export function getFileName(filePath: string): string {
  return filePath.replace(/^.*[/\\]/, '');
}

export function getFileExtension(fileName: string): string {
  const match = fileName.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : '';
}

// ===== 时间格式化 =====
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 30) return `${days} 天前`;

  return new Date(timestamp).toLocaleDateString('zh-CN');
}
