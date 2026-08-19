/**
 * 安全模块 - 路径访问控制
 * 最高优先级：防止路径遍历攻击和系统目录泄露
 */

import path from 'path';
import os from 'os';

// fs 仅在 Node 端用于 realpathSync（解析符号链接真实路径）。
// shared 包同时被浏览器端（web）消费，静态 import 会令 webpack 构建失败，
// 因此懒加载并在非 Node 环境回退为 null。
import type * as Fs from 'fs';

let _fs: typeof Fs | null | undefined = undefined;
function getNodeFs(): typeof Fs | null {
  if (_fs !== undefined) return _fs;
  try {
    if (typeof process !== 'undefined' && process.versions?.node) {
      // 间接 eval 隐藏 require，避免 webpack 静态分析尝试打包 'fs'
      _fs = (0, eval)('require')('fs') as typeof Fs;
    } else {
      _fs = null;
    }
  } catch {
    _fs = null;
  }
  return _fs;
}
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
/**
 * 在大小写不敏感的文件系统（Windows / 默认 macOS）上，
 * path.resolve() 保留输入大小写，而文件系统按不敏感方式比对。
 * 统一转为小写后再比较，既防止白名单误拒，也防止系统黑名单被大小写变种绕过。
 */
function normalizeForCompare(p: string): string {
  const platform = process.platform;
  return (platform === 'win32' || platform === 'darwin') ? p.toLowerCase() : p;
}

export function isPathAllowed(
  requestedPath: string,
  allowedDirs: string[]
): boolean {
  // 1. 解析为绝对路径，消除 ../  ./ 等相对路径攻击（词法归一，不解符号链接）
  const resolved = path.resolve(requestedPath);
  const resolvedNorm = normalizeForCompare(resolved);

  // 2. 检查是否在任何允许目录的子路径下
  return allowedDirs.some(allowed => {
    const resolvedAllowed = normalizeForCompare(path.resolve(allowed));
    // 必须以允许目录 + 路径分隔符开头，防止前缀匹配攻击
    // 例如: /home/user 不应该匹配 /home/user2
    return resolvedNorm === resolvedAllowed ||
           resolvedNorm.startsWith(resolvedAllowed + path.sep);
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
    let resolved = path.resolve(requestedPath);

    // 步骤 1b: 解析符号链接真实路径，防止 symlink 逃逸白名单/黑名单
    // realpathSync 在目标不存在时抛出 ENOENT，此时回退到 resolve 后的路径。
    // fs 在浏览器端不可用（getNodeFs 返回 null），跳过解析，依赖步骤 1 的词法归一。
    const fs = getNodeFs();
    if (fs) {
      try {
        const real = fs.realpathSync(resolved);
        // 重新归一化真实路径（realpathSync 也可能保留大小写）
        resolved = real;
      } catch {
        // 目标不存在（如新建目录请求）：以 resolve 路径继续校验
      }
    }
    const resolvedNorm = normalizeForCompare(resolved);

    // 步骤 2: 检查系统黑名单（优先于白名单）
    const platform = os.platform() as 'win32' | 'darwin' | 'linux';
    const blocked = getBlockedDirsForPlatform(platform);

    const isSystemBlocked = blocked.some(blockedDir => {
      const resolvedBlocked = normalizeForCompare(path.resolve(blockedDir));
      return resolvedNorm === resolvedBlocked ||
             resolvedNorm.startsWith(resolvedBlocked + path.sep);
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
  // Electron utility process 由 relay-wrapper.js 在加载 bundle.js 前注入 polyfill，
  // 因此此处可安全地直接使用 globalThis.crypto（不引入 node:crypto，保持浏览器兼容）。
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
} as const;
// ===== Rate Limiting 配置 =====
// 各字段支持通过 RL_* 环境变量覆盖，仅用于集成测试环境（提高主机注册上限避免并发测试文件触发 429）。
// 生产环境不传这些环境变量，使用下方安全默认值。
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  // 非数值 / NaN / 非正数 → 回退默认值，避免 fail-open（NaN 比较总为 false 导致限流失效）
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const RATE_LIMIT_CONFIG = {
  AUTH_MAX: envInt('RL_AUTH_MAX', 10),
  PIN_GENERATE_MAX: envInt('RL_PIN_MAX', 5),
  REGISTER_HOST_MAX: envInt('RL_REGISTER_MAX', 5),
  WINDOW_MS: envInt('RL_WINDOW_MS', 60000),
};
// ===== 下载令牌配置 =====
export const DOWNLOAD_TOKEN_CONFIG = {
  EXPIRY_MS: 30 * 60 * 1000,  // 30 分钟
  MAX_USES: 1,                  // 默认单次使用
};
