/**
 * 安全模块 - 路径访问控制
 * 最高优先级：防止路径遍历攻击和系统目录泄露
 */

import path from 'path';
import os from 'os';

// ===== 系统保护目录黑名单 =====
// 绝对禁止远程访问的系统目录
export const SYSTEM_BLOCKED_DIRS: Record<string, string[]> = {
  win32: [
    'C:\\Windows',
    'C:\\Windows\\System32',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
    // 注意: %APPDATA% 和 %LOCALAPPDATA% 需要在运行时解析
  ],
  darwin: [
    '/System',
    '/Library',
    '/usr',
    '/etc',
    '/bin',
    '/sbin',
    '/private',
    '/var',
  ],
  linux: [
    '/etc',
    '/bin',
    '/sbin',
    '/usr',
    '/lib',
    '/lib64',
    '/boot',
    '/sys',
    '/proc',
    '/root',
    '/dev',
  ],
};

// ===== Windows 特殊目录解析 =====
// 返回新数组，避免重复调用污染 SYSTEM_BLOCKED_DIRS.win32 本身
export function getWindowsBlockedDirs(): string[] {
  const dirs = [...SYSTEM_BLOCKED_DIRS.win32];
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;

  if (appData) dirs.push(appData);
  if (localAppData) dirs.push(localAppData);

  return dirs;
}

// ===== 按平台获取系统黑名单目录 =====
export function getBlockedDirsForPlatform(platform: 'win32' | 'darwin' | 'linux'): string[] {
  return platform === 'win32' ? getWindowsBlockedDirs() : SYSTEM_BLOCKED_DIRS[platform] || [];
}

// ===== 路径安全校验 =====
export function isPathAllowed(
  requestedPath: string,
  allowedDirs: string[]
): boolean {
  // 1. 解析为绝对路径，消除 ../  ./ 等相对路径攻击
  const resolved = path.resolve(requestedPath);

  // 2. 检查是否在任何允许目录的子路径下
  return allowedDirs.some(allowed => {
    const resolvedAllowed = path.resolve(allowed);
    // 必须以允许目录 + 路径分隔符开头，防止前缀匹配攻击
    // 例如: /home/user 不应该匹配 /home/user2
    return resolved === resolvedAllowed ||
           resolved.startsWith(resolvedAllowed + path.sep);
  });
}

// ===== 完整的路径验证函数 =====
export interface PathValidationResult {
  allowed: boolean;
  reason?: 'SYSTEM_PROTECTED' | 'NOT_IN_WHITELIST' | 'INVALID_PATH';
}

export function validateDirectoryRequest(
  requestedPath: string,
  allowedDirs: Array<{ path: string; is_active: boolean }>
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

    if (!isPathAllowed(resolved, activeAllowed)) {
      return { allowed: false, reason: 'NOT_IN_WHITELIST' };
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: 'INVALID_PATH' };
  }
}

// ===== PIN 码安全 =====
// 排除容易混淆的字符: 0/O/I/1/l
export const PIN_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generatePin(length: number = 8): string {
  // 使用加密安全随机源（Node 18+ 与浏览器均提供 globalThis.crypto）
  // rejection sampling 避免 256 % 31 != 0 带来的取模偏差
  const cryptoObj = globalThis.crypto;
  const maxValid = Math.floor(256 / PIN_CHARS.length) * PIN_CHARS.length;
  let pin = '';
  const buf = new Uint8Array(length * 2);
  while (pin.length < length) {
    cryptoObj.getRandomValues(buf);
    for (let i = 0; i < buf.length && pin.length < length; i++) {
      if (buf[i] < maxValid) {
        pin += PIN_CHARS.charAt(buf[i] % PIN_CHARS.length);
      }
    }
  }
  return pin;
}

// ===== JWT 配置 =====
export const JWT_CONFIG = {
  ACCESS_TOKEN_EXPIRY: '2h',
  REFRESH_TOKEN_EXPIRY: '30d',
  // 从 365d 缩短至 90d（02a-S13）；配套的桌面端 token-rotator.ts 在过期前
  // 30 天自动调用 POST /auth/host-token-refresh，确保 host 无感知轮换。
  HOST_TOKEN_EXPIRY: '90d',
  // 桌面端触发主动轮换的阈值：剩余有效期 ≤ 此值时发起轮换请求
  HOST_TOKEN_ROTATION_THRESHOLD_DAYS: 30,
} as const;

// ===== Rate Limiting 配置 =====
export const RATE_LIMIT_CONFIG = {
  AUTH_MAX: 10,          // 每 IP 每分钟最多 10 次认证请求
  PIN_GENERATE_MAX: 5,   // 每 Host 每分钟最多 5 次 PIN 生成
  REGISTER_HOST_MAX: 5,  // 每 IP 每分钟最多 5 次主机注册（防止无限制创建主机行的 DB 增长 DoS）
  WINDOW_MS: 60000,      // 1 分钟窗口
};

// ===== 下载令牌配置 =====
export const DOWNLOAD_TOKEN_CONFIG = {
  EXPIRY_MS: 30 * 60 * 1000,  // 30 分钟
  MAX_USES: 1,                  // 默认单次使用
};
