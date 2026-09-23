/**
 * File Handling 设置页
 *
 * 设计规范 (Spec §29):
 * - Default download location
 * - Incoming files: 5 类别使用 compact Setting Row
 * - 保存按钮在 footer 区域
 */
import { Section, Input, Button, Divider } from '../components/ui';
import type { UploadPaths } from './types';
import { CATEGORY_LABELS } from './types';

export interface FileHandlingSettingsProps {
  paths: UploadPaths;
  onPathsChange: (paths: UploadPaths) => void;
  onSelectPath: (category: keyof UploadPaths) => void;
  isSaving: boolean;
  saveStatus: 'idle' | 'success' | 'error';
  onSave: () => void;
}

export function FileHandlingSettings({
  paths,
  onPathsChange,
  onSelectPath,
  isSaving,
  saveStatus,
  onSave,
}: FileHandlingSettingsProps) {
  return (
    <div>
      <header className="mb-6">
        <h2 className="text-2xl font-semibold text-foreground">文件处理</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Web 端发送的文件将按类型自动存入对应目录。未修改时使用平台默认路径。
        </p>
      </header>

      <Section title="接收路径">
        <div className="space-y-3">
          {(Object.keys(CATEGORY_LABELS) as (keyof UploadPaths)[]).map((cat, idx) => (
            <div key={cat}>
              {idx > 0 && <Divider className="my-1" />}
              <div className="flex items-center gap-3">
                <label className="w-20 flex-shrink-0 text-sm text-muted-foreground">
                  {CATEGORY_LABELS[cat]}
                </label>
                <Input
                  value={paths[cat]}
                  onChange={(e) => onPathsChange({ ...paths, [cat]: e.target.value })}
                  placeholder="（使用默认路径）"
                  className="flex-1 font-mono"
                />
                <Button variant="secondary" onClick={() => onSelectPath(cat)}>
                  选择…
                </Button>
              </div>
            </div>
          ))}
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
