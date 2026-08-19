import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import './globals.css';

export const metadata: Metadata = {
  title: 'RemoteBridge - 远程文件桥接系统',
  description: '安全地从任何设备访问您的电脑文件',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      {/* 阻塞式内联脚本：在 React 水合前从 localStorage 读取主题并写入 <html> class，
          消除从默认色 → 持久化主题的视觉闪烁 */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){var t=localStorage.getItem('theme');document.documentElement.classList.toggle('light',t!=='dark');}())` }} />
      </head>
      <body>
        {children}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
