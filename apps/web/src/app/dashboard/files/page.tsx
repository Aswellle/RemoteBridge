'use client';

import { useState, useEffect } from 'react';
import FilePreview from '@/components/previews/FilePreview';
import DownloadPanel from '@/components/DownloadPanel';
import FileList from '@/components/FileList';
import Breadcrumb from '@/components/Breadcrumb';
import { useAppStore } from '@/store/app-store';
import { useWebSocket } from '@/hooks/useWebSocket';
import { FileEntry } from '@remotebridge/shared';

export default function FilesPage() {
  const { connectionStatus, sessionId, currentPath, dirEntries, isLoadingDir, listDir, listAllowed } = useAppStore();
  const { connect } = useWebSocket();
  const [previewFile, setPreviewFile] = useState<{
    path: string;
    name: string;
    extension: string;
  } | null>(null);

  // 初始化 WebSocket 连接 + 加载共享目录白名单
  // 注意：不能瞎猜 Host 的根目录（之前用浏览器自身的 navigator.platform 猜 C:\ 或 /，
  // 既猜错平台又必然不在白名单内）。入口必须是 Host 共享的目录列表。
  useEffect(() => {
    if (connectionStatus === 'connected' && sessionId) {
      connect();
      if (!currentPath && dirEntries.length === 0) {
        listAllowed();
      }
    }
  }, [connectionStatus, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 点击目录
  const handleDirClick = (path: string) => {
    listDir(path);
  };

  // 点击文件 → 始终打开预览模态；不支持预览的类型由 UnsupportedViewer 展示下载按钮，
  // 统一保证"只有用户主动点击下载按钮才触发下载"
  const handleFileClick = (entry: FileEntry) => {
    setPreviewFile({
      path: entry.path,
      name: entry.name,
      extension: entry.extension,
    });
  };

  // 面包屑导航（__ALLOWED_ROOT__ 表示回到共享目录列表）
  const handleBreadcrumbClick = (path: string) => {
    if (path === '__ALLOWED_ROOT__') {
      listAllowed();
    } else {
      listDir(path);
    }
  };

  // 构建面包屑路径：第一级始终是“共享目录”入口，
  // 因为盘符根（C:\ 等）通常不在白名单内，点击必然被拒绝
  const breadcrumbs = [
    { name: '共享目录', path: '__ALLOWED_ROOT__' },
    ...buildBreadcrumbs(currentPath),
  ];

  // 未连接时显示提示（layout 已处理侧边栏，这里只渲染内容区）
  if (connectionStatus !== 'connected') {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-xl text-muted-foreground mb-4">未连接到远程主机</p>
          <a href="/" className="text-primary hover:underline">返回连接页面</a>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="p-8 flex flex-col lg:flex-row gap-6 h-full">
        {/* 左侧: 文件浏览 */}
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-semibold mb-6">文件浏览</h2>

          {/* 面包屑 */}
          <Breadcrumb items={breadcrumbs} onNavigate={handleBreadcrumbClick} />

          {/* 文件列表 */}
          <div className="mt-4 bg-card rounded-lg shadow-lg overflow-hidden">
            {isLoadingDir ? (
              <div className="flex items-center justify-center py-12">
                <svg className="animate-spin h-8 w-8 text-primary mr-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span className="text-muted-foreground">加载中...</span>
              </div>
            ) : (
              <FileList
                entries={dirEntries}
                onDirClick={handleDirClick}
                onFileClick={handleFileClick}
                isRootView={!currentPath}
              />
            )}
          </div>
        </div>

        {/* 右侧: 下载面板 */}
        <div className="w-full lg:w-80 flex-shrink-0">
          <DownloadPanel />
        </div>
      </div>

      {/* 预览弹窗 */}
      {previewFile && (
        <FilePreview
          filePath={previewFile.path}
          fileName={previewFile.name}
          fileExtension={previewFile.extension}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </>
  );
}

// ===== 面包屑路径构建 =====
function buildBreadcrumbs(currentPath: string | null): Array<{ name: string; path: string }> {
  if (!currentPath) return [];

  const parts: Array<{ name: string; path: string }> = [];
  const isWindows = currentPath.includes('\\') || /^[A-Z]:/i.test(currentPath);

  if (isWindows) {
    const drive = currentPath.match(/^([A-Z]:)/i)?.[1] || 'C:';
    parts.push({ name: drive, path: `${drive}\\` });
  } else {
    parts.push({ name: '/', path: '/' });
  }

  const segments = currentPath
    .replace(/^[A-Z]:\\?/i, '')
    .replace(/^\//, '')
    .split(/[/\\]/)
    .filter(Boolean);

  let accumulated = isWindows ? parts[0].path : '/';

  for (const segment of segments) {
    accumulated = isWindows
      ? `${accumulated}${accumulated.endsWith('\\') ? '' : '\\'}${segment}`
      : `${accumulated}${accumulated === '/' ? '' : '/'}${segment}`;

    parts.push({ name: segment, path: accumulated });
  }

  return parts;
}
