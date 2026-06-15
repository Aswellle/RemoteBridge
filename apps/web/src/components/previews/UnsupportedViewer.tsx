'use client';

import { Download, Archive, Cog, Disc, Music, Film, FileText, Table, Presentation, FileQuestion } from 'lucide-react';

interface UnsupportedViewerProps {
  fileName: string;
  onDownload: () => void;
}

export default function UnsupportedViewer({ fileName, onDownload }: UnsupportedViewerProps) {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  // 获取文件类型描述
  const getDescription = (extension: string): string => {
    const types: Record<string, string> = {
      zip: 'ZIP 压缩包',
      rar: 'RAR 压缩包',
      '7z': '7-Zip 压缩包',
      tar: 'TAR 归档文件',
      gz: 'Gzip 压缩文件',
      exe: 'Windows 可执行文件',
      msi: 'Windows 安装包',
      dmg: 'macOS 磁盘映像',
      pkg: 'macOS 安装包',
      deb: 'Debian 软件包',
      rpm: 'RPM 软件包',
      mp3: 'MP3 音频文件',
      wav: 'WAV 音频文件',
      flac: 'FLAC 无损音频',
      mp4: 'MP4 视频文件',
      mkv: 'MKV 视频文件',
      avi: 'AVI 视频文件',
      mov: 'MOV 视频文件',
      doc: 'Word 文档',
      docx: 'Word 文档',
      xls: 'Excel 表格',
      xlsx: 'Excel 表格',
      ppt: 'PowerPoint 演示文稿',
      pptx: 'PowerPoint 演示文稿',
    };
    return types[extension] || '未知文件类型';
  };

  // 获取文件图标组件
  const getIconComponent = (extension: string) => {
    const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz'];
    const execExts = ['exe', 'msi'];
    const diskExts = ['dmg', 'pkg', 'deb', 'rpm'];
    const audioExts = ['mp3', 'wav', 'flac', 'aac', 'ogg'];
    const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'wmv'];
    const docExts = ['doc', 'docx'];
    const sheetExts = ['xls', 'xlsx'];
    const presExts = ['ppt', 'pptx'];

    if (archiveExts.includes(extension)) return Archive;
    if (execExts.includes(extension)) return Cog;
    if (diskExts.includes(extension)) return Disc;
    if (audioExts.includes(extension)) return Music;
    if (videoExts.includes(extension)) return Film;
    if (docExts.includes(extension)) return FileText;
    if (sheetExts.includes(extension)) return Table;
    if (presExts.includes(extension)) return Presentation;
    return FileQuestion;
  };

  const IconComponent = getIconComponent(ext);

  return (
    <div className="flex items-center justify-center h-96">
      <div className="text-center max-w-md">
        <IconComponent className="w-16 h-16 mx-auto mb-6 text-muted-foreground" />
        <h3 className="text-xl font-semibold text-foreground mb-2">{fileName}</h3>
        <p className="text-muted-foreground mb-2">{getDescription(ext)}</p>
        <p className="text-muted-foreground text-sm mb-8">
          此文件类型暂不支持在线预览，请下载后使用本地应用打开。
        </p>
        <button
          onClick={onDownload}
          className="flex items-center gap-2 mx-auto px-8 py-3 bg-primary hover:bg-primary/90 text-white font-medium rounded-lg transition-colors"
        >
          <Download className="w-5 h-5" />
          下载文件
        </button>
      </div>
    </div>
  );
}
