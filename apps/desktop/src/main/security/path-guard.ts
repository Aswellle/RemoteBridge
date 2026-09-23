import path from 'path';
import os from 'os';
import { realpathSync } from 'fs';
import fs from 'node:fs/promises';
import { getBlockedDirsForPlatform } from '@remotebridge/shared';
import type { PathValidationResult } from '@remotebridge/shared';
import log from '../logger';


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
 
    // Step 1.5: resolve symlinks to prevent escape via symlinks
    let realResolved: string;
    try {
      realResolved = realpathSync(resolved);
    } catch {
      realResolved = resolved; // file may not exist yet
    }

     // 步骤 2: 检查系统黑名单（优先于白名单），使用真实路径防止符号链接逃逸
     const platform = os.platform() as 'win32' | 'darwin' | 'linux';
     const blocked = getBlockedDirsForPlatform(platform);
 
     const isSystemBlocked = blocked.some(blockedDir => {
       const resolvedBlocked = path.resolve(blockedDir);
      return realResolved === resolvedBlocked ||
             realResolved.startsWith(resolvedBlocked + path.sep);
     });
 
    if (isSystemBlocked) {
      log.warn(`路径安全: 拒绝访问系统保护目录 ${requestedPath} (原因: SYSTEM_PROTECTED, 真实路径: ${realResolved})`);
      return { allowed: false, reason: 'SYSTEM_PROTECTED' };
    }

    // 步骤 3: 检查白名单
    const activeAllowed = allowedDirs
      .filter(d => d.is_active)
       .map(d => d.path);

    if (!isPathInWhitelist(realResolved, activeAllowed)) {
      log.warn(`路径安全: 拒绝访问不在白名单的路径 ${requestedPath} (原因: NOT_IN_WHITELIST, 真实路径: ${realResolved})`);
      return { allowed: false, reason: 'NOT_IN_WHITELIST' };
    }

    // 步骤 4: 检查递归权限（V2: 最长路径匹配）
    // 找到最长匹配的允许目录，正确处理嵌套目录（如 /home/user 和 /home/user/projects）
    const activeAllowedDirs = allowedDirs.filter(d => d.is_active);
    let longestMatch: AllowedDirectory | null = null;
    let longestMatchLen = 0;

    for (const d of activeAllowedDirs) {
      const resolvedAllowed = path.resolve(d.path);
      if (realResolved === resolvedAllowed || realResolved.startsWith(resolvedAllowed + path.sep)) {
        if (resolvedAllowed.length > longestMatchLen) {
          longestMatch = d;
          longestMatchLen = resolvedAllowed.length;
        }
      }
    }
    if (longestMatch && !longestMatch.recursive) {
      const resolvedAllowed = path.resolve(longestMatch.path);
      if (realResolved !== resolvedAllowed) {
        log.warn(`路径安全: 拒绝访问非递归目录的子目录 ${requestedPath} (原因: NOT_RECURSIVE, 允许目录: ${longestMatch.path})`);
        return { allowed: false, reason: 'NOT_IN_WHITELIST' };
      }
    }


     return { allowed: true };
   } catch {
     return { allowed: false, reason: 'INVALID_PATH' };
   }
 }

// ===== V2: Windows 路径规范化 =====
/**
 * 规范化路径用于比较。
 * Windows: 转为小写并使用反斜杠，确保大小写不敏感比较。
 * Unix: 保持不变（大小写敏感）。
 */
export function normalizePathForComparison(filePath: string): string {
  if (os.platform() === 'win32') {
    return path.resolve(filePath).toLowerCase().replace(/\//g, '\\');
  }
  return path.resolve(filePath);
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

  // resolve symlinks to prevent escape via symlinks
  let realResolved: string;
  try {
    realResolved = realpathSync(resolved);
  } catch {
    realResolved = resolved; // path may not exist yet
  }

   const platform = os.platform() as 'win32' | 'darwin' | 'linux';
   const blocked = getBlockedDirsForPlatform(platform);
 
   return blocked.some(blockedDir => {
     const resolvedBlocked = path.resolve(blockedDir);
    return realResolved === resolvedBlocked ||
           realResolved.startsWith(resolvedBlocked + path.sep);
   });
 }

// ===== V2: TOCTOU 加固 =====
/**
 * 验证已打开的文件句柄仍然指向白名单内的路径（TOCTOU 防护）。
 * 在 fs.open() 之后调用，使用 fstat 检查文件是否被篡改。
 *
 * @param fd - 已打开的文件描述符（来自 fs.open）
 * @param allowedDirs - 当前白名单目录列表
 * @returns true 表示安全，false 表示路径在 check 和 use 之间被篡改
export async function validatePathTOCTOU(fd: number, allowedDirs: AllowedDirectory[]): Promise<boolean> {
  try {
    // 使用 fstat 获取已打开文件的真实信息（不受后续 symlink 替换影响）
    const stat = await fs.fstat(fd);

    // 确保仍然是常规文件（不是被替换为 symlink/device）
    if (!stat.isFile() && !stat.isDirectory()) {
      log.warn(`TOCTOU: 文件句柄非常规文件类型 (mode: ${stat.mode})`);
      return false;
    }

    // 尝试通过 /proc/self/fd/<fd> 获取真实路径（Linux）
    let realFdPath: string | null = null;
    try {
      realFdPath = await fs.readlink(`/proc/self/fd/${fd}`);
    } catch {
      // 非 Linux 平台或 /proc 不可用 — 跳过路径重校验
    }

    if (realFdPath) {
      const resolvedReal = path.resolve(realFdPath);
      const activeAllowed = allowedDirs.filter(d => d.is_active).map(d => d.path);
      if (!isPathInWhitelist(resolvedReal, activeAllowed)) {
        log.warn(`TOCTOU: 文件句柄真实路径不在白名单内 (${resolvedReal})`);
        return false;
      }
    }

    return true;
  } catch (err) {
    log.error(`TOCTOU: fstat 校验失败: ${err}`);
    return false;
  }
}
      // 解析 /proc/self/fd 返回的路径（可能是相对路径）
      const resolvedReal = path.resolve(realFdPath);

      // 重新校验白名单
      const activeAllowed = allowedDirs.filter(d => d.is_active).map(d => d.path);
      if (!isPathInWhitelist(resolvedReal, activeAllowed)) {
        log.warn(`TOCTOU: 文件句柄真实路径不在白名单内 (${resolvedReal})`);
        return false;
      }
    }

    return true;
  } catch (err) {
    log.error(`TOCTOU: fstat 校验失败: ${err}`);
    return false;
  }
}

/**
 * 清除路径缓存（用于测试）。
 */
export function clearPathCache(): void {
  // no-op in this implementation; placeholder for future LRU cache
}

