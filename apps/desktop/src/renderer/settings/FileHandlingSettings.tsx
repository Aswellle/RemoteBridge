/**
 * File Handling 设置页
 *
 * 设计规范 (Spec §29):
 * - Default download location
 * - Incoming files: 5 类别使用 compact Setting Row
 * - 保存按钮在 footer 区域
 *
 * 交互要点：
 * - 每个类别都回显**当前实际生效的完整路径**（未自定义时为平台默认路径），
 *   而不是只显示"使用默认路径"占位符——用户需要知道文件究竟存到哪。
 * - 每个类别提供一键"打开"直达该目录；提供"恢复默认"以便从自定义撤销回默认。
 */
import { FolderOpen, RotateCcw } from 'lucide-react';
import { Section, Input, Button, Divider } from '../components/ui';
import type { UploadPaths } from './types';
import { CATEGORY_LABELS } from './types';

export interface FileHandlingSettingsProps {
  paths: UploadPaths;
  /** 平台默认路径，用于标记"默认"状态与一键恢复 */
  defaults: UploadPaths | null;
  onPathsChange: (paths: UploadPaths) => void;
  onSelectPath: (category: keyof UploadPaths) => void;
  /** 在系统文件管理器中打开该类别的保存目录 */
  onOpenPath: (category: keyof UploadPaths) => void;
  /** 将单个类别恢复为平台默认路径 */
  onResetPath: (category: keyof UploadPaths) => void;
  isSaving: boolean;
  saveStatus: 'idle' | 'success' | 'error';
  onSave: () => void;
}

export function FileHandlingSettings({
  paths,
  defaults,
  onPathsChange,
  onSelectPath,
  onOpenPath,
  onResetPath,
  isSaving,
  saveStatus,
  onSave,
}: FileHandlingSettingsProps) {
  const categories = Object.keys(CATEGORY_LABELS) as (keyof UploadPaths)[];

  return (
    <div>
      <header className="mb-6">
        <h2 className="text-2xl font-semibold text-foreground">文件处理</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Web 端发送的文件将按类型自动存入对应目录。下方显示当前实际使用的完整路径。
        </p>
      </header>

      <Section title="接收路径">
        <div className="space-y-3">
          {categories.map((cat, idx) => {
            const value = paths[cat] ?? '';
            const isDefault = !!defaults && value === defaults[cat];
            return (
              <div key={cat}>
                {idx > 0 && <Divider className="my-1" />}
                <div className="flex items-center gap-3">
                  <label className="flex w-20 flex-shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
                    {CATEGORY_LABELS[cat]}
                    {isDefault && (
                      <span
                        className="rounded-xs bg-surface-subtle px-1 py-0.5 text-[10px] leading-none text-muted-foreground"
                        title="当前使用平台默认路径"
                      >
                        默认
                      </span>
                    )}
                  </label>
                  <Input
                    value={value}
                    onChange={(e) => onPathsChange({ ...paths, [cat]: e.target.value })}
                    placeholder={defaults?.[cat] ?? '（使用默认路径）'}
                    className="flex-1 font-mono text-xs"
                    title={value || defaults?.[cat] || ''}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onOpenPath(cat)}
                    title="在文件管理器中打开该目录"
                    aria-label={`打开${CATEGORY_LABELS[cat]}保存目录`}
                    disabled={!(value || defaults?.[cat])}
                  >
                    <FolderOpen className="size-3.5" />
                    打开
                  </Button>
                  <Button
                    variant="icon"
                    onClick={() => onResetPath(cat)}
                    title="恢复为平台默认路径"
                    aria-label={`恢复${CATEGORY_LABELS[cat]}默认路径`}
                    disabled={isDefault}
                  >
                    <RotateCcw className="size-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {/* 操作 */}
      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" onClick={onSave} disabled={isSaving}>
          {isSaving ? '保存中...' : '保存路径'}
        </Button>
        {saveStatus === 'success' && (
          <span className="flex items-center gap-1 text-sm text-success">已保存</span>
        )}
        {saveStatus === 'error' && (
          <span className="flex items-center gap-1 text-sm text-destructive">保存失败</span>
        )}
      </div>
    </div>
  );
}
