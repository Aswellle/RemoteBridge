import { describe, it, expect } from 'vitest';
import {
  isPathAllowed,
  validateDirectoryRequest,
  getWindowsBlockedDirs,
  getBlockedDirsForPlatform,
  SYSTEM_BLOCKED_DIRS,
  generatePin,
  PIN_CHARS,
} from '../src/security';

describe('isPathAllowed', () => {
  it('allows paths inside a whitelisted directory', () => {
    expect(isPathAllowed('/home/user/docs/file.txt', ['/home/user'])).toBe(true);
  });

  it('allows the whitelisted directory itself', () => {
    expect(isPathAllowed('/home/user', ['/home/user'])).toBe(true);
  });

  it('rejects sibling directories sharing a name prefix', () => {
    expect(isPathAllowed('/home/user2/file.txt', ['/home/user'])).toBe(false);
  });

  it('rejects paths outside all whitelisted directories', () => {
    expect(isPathAllowed('/srv/secret/data', ['/home/user'])).toBe(false);
  });
});

describe('validateDirectoryRequest', () => {
  const allowedDirs = [{ path: '/home/user/shared', is_active: true }];

  it('allows a path inside an active whitelist entry', () => {
    const result = validateDirectoryRequest('/home/user/shared/docs', allowedDirs);
    expect(result).toEqual({ allowed: true });
  });

  it('rejects a path outside the whitelist', () => {
    const result = validateDirectoryRequest('/home/user/other', allowedDirs);
    expect(result).toEqual({ allowed: false, reason: 'NOT_IN_WHITELIST' });
  });

  it('ignores inactive whitelist entries', () => {
    const result = validateDirectoryRequest('/home/user/shared/docs', [
      { path: '/home/user/shared', is_active: false },
    ]);
    expect(result).toEqual({ allowed: false, reason: 'NOT_IN_WHITELIST' });
  });
});
describe('isPathAllowed — case-insensitive filesystem (SEC: case normalization)', () => {
  // Windows / macOS 默认大小写不敏感：白名单 /home/user 应匹配 /HOME/USER/docs，
  // 同时系统黑名单 C:\Windows 不能被 c:\windows 绕过。
  // 直接注入 platform 参数，避免 mock process.platform（在部分 Node 版本不可靠）。

  it('matches whitelist path with different case on win32', () => {
    expect(isPathAllowed('C:\\USERS\\Alice\\docs', ['C:\\Users\\Alice'], 'win32')).toBe(true);
  });

  it('matches whitelist path with different case on darwin', () => {
    expect(isPathAllowed('/HOME/user/docs', ['/home/user'], 'darwin')).toBe(true);
  });

  it('does NOT match a different-case sibling directory', () => {
    // /home/user2 不是 /home/user 的子路径，大小写变化也不应误匹配
    expect(isPathAllowed('/HOME/USER2/file.txt', ['/home/user'], 'win32')).toBe(false);
  });

  it('on linux (case-sensitive) preserves exact matching', () => {
    expect(isPathAllowed('/HOME/user/docs', ['/home/user'], 'linux')).toBe(false);
    expect(isPathAllowed('/home/user/docs', ['/home/user'], 'linux')).toBe(true);
  });
});

describe('validateDirectoryRequest — case & symlink (SEC)', () => {
  it('rejects a system-blocked dir reached even with different case on win32', () => {
    const result = validateDirectoryRequest('c:\\windows\\system32', [
      { path: 'C:\\Users\\Public', is_active: true },
    ], 'win32');
    expect(result).toEqual({ allowed: false, reason: 'SYSTEM_PROTECTED' });
  });

  it('allows a whitelisted path with non-existent target (falls back to resolve path)', () => {
    // realpathSync 对不存在路径抛 ENOENT，应回退到 path.resolve 继续校验
    const result = validateDirectoryRequest('/home/user/shared/newdir', [
      { path: '/home/user/shared', is_active: true },
    ]);
    expect(result).toEqual({ allowed: true });
  });
});

describe('getWindowsBlockedDirs', () => {
  it('does not mutate SYSTEM_BLOCKED_DIRS.win32 across repeated calls', () => {
    const originalLength = SYSTEM_BLOCKED_DIRS.win32.length;
    getWindowsBlockedDirs();
    getWindowsBlockedDirs();
    getWindowsBlockedDirs();
    expect(SYSTEM_BLOCKED_DIRS.win32.length).toBe(originalLength);
  });

  it('includes %APPDATA% and %LOCALAPPDATA% when set', () => {
    const prevAppData = process.env.APPDATA;
    const prevLocalAppData = process.env.LOCALAPPDATA;
    try {
      process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
      process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';

      const dirs = getWindowsBlockedDirs();
      expect(dirs).toContain('C:\\Users\\test\\AppData\\Roaming');
      expect(dirs).toContain('C:\\Users\\test\\AppData\\Local');
      expect(dirs).toEqual(expect.arrayContaining([...SYSTEM_BLOCKED_DIRS.win32]));
    } finally {
      if (prevAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prevAppData;
      if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prevLocalAppData;
    }
  });

  it('omits %APPDATA%/%LOCALAPPDATA% when unset', () => {
    const prevAppData = process.env.APPDATA;
    const prevLocalAppData = process.env.LOCALAPPDATA;
    try {
      delete process.env.APPDATA;
      delete process.env.LOCALAPPDATA;

      const dirs = getWindowsBlockedDirs();
      expect(dirs).toEqual(SYSTEM_BLOCKED_DIRS.win32);
    } finally {
      if (prevAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prevAppData;
      if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prevLocalAppData;
    }
  });
});

describe('getBlockedDirsForPlatform', () => {
  it('returns the static list for non-Windows platforms', () => {
    expect(getBlockedDirsForPlatform('linux')).toEqual(SYSTEM_BLOCKED_DIRS.linux);
    expect(getBlockedDirsForPlatform('darwin')).toEqual(SYSTEM_BLOCKED_DIRS.darwin);
  });

  it('delegates to getWindowsBlockedDirs for win32', () => {
    expect(getBlockedDirsForPlatform('win32')).toEqual(getWindowsBlockedDirs());
  });
});

describe('generatePin', () => {
  it('generates a PIN of the requested length using the confusion-avoiding charset', () => {
    const pin = generatePin(8);
    expect(pin).toHaveLength(8);
    for (const char of pin) {
      expect(PIN_CHARS).toContain(char);
    }
  });

  it('excludes confusable characters', () => {
    const pin = generatePin(200);
    for (const ambiguous of ['0', 'O', 'I', '1', 'l']) {
      expect(pin).not.toContain(ambiguous);
    }
  });
});
