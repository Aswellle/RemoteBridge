'use client';

import { useMemo } from 'react';
import { Folder, File, FileText, FileCode, FileImage, FileVideo, FileAudio, FileArchive, FileSpreadsheet, FileKey, FileType, FolderOpen } from 'lucide-react';
import { Skeleton } from '@/components/ui/Skeleton';
import { FileEntry } from '@remotebridge/shared';
import { formatFileSize, formatRelativeTime, getFileCategory } from '@remotebridge/shared';

interface FileListProps {
  entries: FileEntry[];
  onDirClick: (path: string) => void;
  onFileClick: (entry: FileEntry) => void;
  loading?: boolean;
}

function getFileLucideIcon(extension?: string) {
  if (!extension) return File;
  const ext = extension.toLowerCase();
  const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv'];
  const audioExts = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma'];
  const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'];
  const codeExts = ['ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'css', 'scss', 'less', 'sh', 'bash', 'html', 'sql'];
  const sheetExts = ['xls', 'xlsx', 'csv'];
  const keyExts = ['pem', 'key', 'cert', 'crt', 'p12'];

  if (videoExts.includes(ext)) return FileVideo;
  if (audioExts.includes(ext)) return FileAudio;
  if (archiveExts.includes(ext)) return FileArchive;
  if (keyExts.includes(ext)) return FileKey;
  if (sheetExts.includes(ext)) return FileSpreadsheet;

  const category = getFileCategory(ext);
  if (category === 'image') return FileImage;
  if (category === 'pdf') return FileType;
  if (category === 'text') return codeExts.includes(ext) ? FileCode : FileText;

  return File;
}

export default function FileList({ entries, onDirClick, onFileClick, loading }: FileListProps) {
  // 排序：目录在前，文件在后，各自按名称排序
  const sortedEntries = useMemo(() => [...entries].sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name);
  }), [entries]);

  if (loading) {
    return (
      <div className="divide-y divide-border">
        <div className="grid grid-cols-12 gap-4 px-6 py-3 text-sm font-medium text-muted-foreground bg-card/80">
          <div className="col-span-6">名称</div>
          <div className="col-span-2 text-right">大小</div>
          <div className="col-span-2">类型</div>
          <div className="col-span-2 text-right">修改时间</div>
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="grid grid-cols-12 gap-4 px-6 py-3 items-center">
            <div className="col-span-6 flex items-center">
              <Skeleton className="w-5 h-5 mr-3 rounded" />
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="col-span-2 flex justify-end">
              <Skeleton className="h-4 w-14" />
            </div>
            <div className="col-span-2">
              <Skeleton className="h-4 w-10" />
            </div>
            <div className="col-span-2 flex justify-end">
              <Skeleton className="h-4 w-20" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (sortedEntries.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <FolderOpen className="w-10 h-10 mx-auto mb-2 text-muted-foreground" />
        <p>此目录为空</p>
        <p className="text-sm mt-1 text-muted-foreground">将文件拖放到此目录或从主机端添加</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border" role="list">
      <div className="grid grid-cols-12 gap-4 px-6 py-3 text-sm font-medium text-muted-foreground bg-card/80">
        <div className="col-span-6">名称</div>
        <div className="col-span-2 text-right">大小</div>
        <div className="col-span-2">类型</div>
        <div className="col-span-2 text-right">修改时间</div>
      </div>

      {/* 文件列表 */}
      {sortedEntries.map((entry) => (
        <FileRow
          key={entry.path}
          entry={entry}
          onDirClick={onDirClick}
          onFileClick={onFileClick}
        />
      ))}
    </div>
  );
}

// ===== 单行文件组件 =====
interface FileRowProps {
  entry: FileEntry;
  onDirClick: (path: string) => void;
  onFileClick: (entry: FileEntry) => void;
}

function FileRow({ entry, onDirClick, onFileClick }: FileRowProps) {
  const isDir = entry.type === 'dir';
  const IconComponent = isDir ? Folder : getFileLucideIcon(entry.extension);
  const category = isDir ? null : getFileCategory(entry.extension);

  const iconColor = isDir
    ? 'text-primary'
    : category === 'image'
    ? 'text-pink-400'
    : category === 'text'
    ? 'text-success'
    : category === 'pdf'
    ? 'text-destructive'
    : 'text-muted-foreground';

  const handleClick = () => {
    if (isDir) {
      onDirClick(entry.path);
    } else {
      onFileClick(entry);
    }
  };

  return (
    <div
      className="grid grid-cols-12 gap-4 px-6 py-3 hover:bg-secondary/50 cursor-pointer transition-colors items-center"
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } }}
      aria-label={isDir ? `文件夹: ${entry.name}` : `文件: ${entry.name}${entry.size ? `, ${formatFileSize(entry.size)}` : ''}`}
    >
      {/* 名称 */}
      <div className="col-span-6 flex items-center min-w-0">
        <IconComponent className={`w-5 h-5 mr-3 flex-shrink-0 ${iconColor}`} />
        <span className={`truncate ${isDir ? 'text-primary hover:underline' : 'text-foreground'}`}>
          {entry.name}
        </span>
      </div>

      {/* 大小 */}
      <div className="col-span-2 text-right text-muted-foreground text-sm">
        {isDir ? '—' : formatFileSize(entry.size)}
      </div>

      {/* 类型 */}
      <div className="col-span-2 text-muted-foreground text-sm">
        {isDir ? '文件夹' : (entry.extension ? `.${entry.extension}` : '文件')}
      </div>

      {/* 修改时间 */}
      <div className="col-span-2 text-right text-muted-foreground text-sm">
        {formatRelativeTime(entry.modifiedAt)}
      </div>
    </div>
  );
}
