import path from 'path';
import os from 'os';
import { getBlockedDirsForPlatform } from '@remotebridge/shared';
import type { PathValidationResult } from '@remotebridge/shared';

// ===== 允许目录接口 =====
interface AllowedDirectory {
  id: number;
  path: string;
  label?: string;
  permission: 'readonly' | 'download';
  recursive: boolean;
  is_active: boolean;
}

// ===== 路径安全守卫 =====
export function validatePath(
  requestedPath: string,
  allowedDirs: AllowedDirectory[]
): PathValidationResult {
  try {
    // 步骤 1: path.resolve() 规范化，防止 ../ 攻击
    const resolved = path.resolve(requestedPath);

    // 步骤 2: 检查系统黑名单（优先于白名单）
    const platform = os.platform() as 'win32' | 'darwin' | 'linux';
    const blocked = getBlockedDirsForPlatform(platform);

    const isSystemBlocked = blocked.some(blockedDir => {
      const resolvedBlocked = path.resolve(blockedDir);
      return resolved === resolvedBlocked ||
             resolved.startsWith(resolvedBlocked + path.sep);
    });

    if (isSystemBlocked) {
      return { allowed: false, reason: 'SYSTEM_PROTECTED' };
    }

    // 步骤 3: 检查白名单
    const activeAllowed = allowedDirs
      .filter(d => d.is_active)
      .map(d => d.path);

    if (!isPathInWhitelist(resolved, activeAllowed)) {
      return { allowed: false, reason: 'NOT_IN_WHITELIST' };
    }

    // 步骤 4: 检查递归权限
    const matchingDir = allowedDirs.find(d => {
      const resolvedAllowed = path.resolve(d.path);
      return resolved === resolvedAllowed ||
             resolved.startsWith(resolvedAllowed + path.sep);
    });

    if (matchingDir && !matchingDir.recursive) {
      const resolvedAllowed = path.resolve(matchingDir.path);
      if (resolved !== resolvedAllowed) {
        return { allowed: false, reason: 'NOT_IN_WHITELIST' };
      }
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: 'INVALID_PATH' };
  }
}

// ===== 白名单检查 =====
function isPathInWhitelist(resolvedPath: string, allowedDirs: string[]): boolean {
  return allowedDirs.some(allowed => {
    const resolvedAllowed = path.resolve(allowed);
    return resolvedPath === resolvedAllowed ||
           resolvedPath.startsWith(resolvedAllowed + path.sep);
  });
}

// ===== 检查是否为系统保护目录 =====
export function isSystemDirectory(dirPath: string): boolean {
  const resolved = path.resolve(dirPath);
  const platform = os.platform() as 'win32' | 'darwin' | 'linux';
  const blocked = getBlockedDirsForPlatform(platform);

  return blocked.some(blockedDir => {
    const resolvedBlocked = path.resolve(blockedDir);
    return resolved === resolvedBlocked ||
           resolved.startsWith(resolvedBlocked + path.sep);
  });
}
