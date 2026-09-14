import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import os from 'os';
import {
  validatePath,
  normalizePathForComparison,
} from '../src/main/security/path-guard';

// Mock logger to capture audit logs
vi.mock('../src/main/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import log from '../src/main/logger';

const nestedAllowedDirs = [
  { id: 1, path: '/home/user', permission: 'download' as const, recursive: true, is_active: true },
  { id: 2, path: '/home/user/projects', permission: 'download' as const, recursive: true, is_active: true },
  { id: 3, path: '/home/user/secret', permission: 'readonly' as const, recursive: false, is_active: true },
];

describe('PathGuard V2 — longest path match', () => {
  it('matches the longest allowed directory for nested paths', () => {
    // /home/user/projects/app should match /home/user/projects (longer), not /home/user
    const result = validatePath('/home/user/projects/app/src/main.ts', nestedAllowedDirs);
    expect(result).toEqual({ allowed: true });
  });

  it('allows access to the nested directory itself', () => {
    const result = validatePath('/home/user/projects', nestedAllowedDirs);
    expect(result).toEqual({ allowed: true });
  });

  it('respects non-recursive on the longest match', () => {
    // /home/user/secret is non-recursive, so subdirs should be rejected
    const result = validatePath('/home/user/secret/subdir/file.txt', nestedAllowedDirs);
    expect(result).toEqual({ allowed: false, reason: 'NOT_IN_WHITELIST' });
  });

  it('allows the non-recursive directory itself', () => {
    const result = validatePath('/home/user/secret', nestedAllowedDirs);
    expect(result).toEqual({ allowed: true });
  });
});

describe('PathGuard V2 — audit logging', () => {
  it('logs a warning when access is denied (SYSTEM_PROTECTED)', () => {
    const platform = os.platform() as 'win32' | 'darwin' | 'linux';
    const blockedDirs = {
      win32: 'C:\\Windows\\System32',
      darwin: '/System',
      linux: '/etc',
    };
    const blockedPath = blockedDirs[platform];
    if (!blockedPath) return; // skip if unknown platform

    validatePath(blockedPath, nestedAllowedDirs);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('SYSTEM_PROTECTED'),
    );
  });

  it('logs a warning when path is not in whitelist', () => {
    validatePath('/some/random/path', nestedAllowedDirs);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('NOT_IN_WHITELIST'),
    );
  });

  it('logs a warning for non-recursive subdirectory access', () => {
    validatePath('/home/user/secret/sub', nestedAllowedDirs);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('NOT_RECURSIVE'),
    );
  });
});

describe('PathGuard V2 — Windows path normalization', () => {
  it('normalizes Windows paths to lowercase with backslashes', () => {
    if (os.platform() !== 'win32') {
      // On non-Windows, just verify the function exists and returns resolved path
      const result = normalizePathForComparison('/Some/Path');
      expect(result).toBe(path.resolve('/Some/Path'));
      return;
    }
    // On Windows, verify lowercase + backslash normalization
    const result = normalizePathForComparison('C:\\Users\\Test\\File.TXT');
    expect(result).toBe('c:\\users\\test\\file.txt');
  });

  it('normalizes Unix paths as-is (case sensitive)', () => {
    if (os.platform() === 'win32') return; // skip on Windows
    const result = normalizePathForComparison('/Home/User/File.txt');
    expect(result).toBe(path.resolve('/Home/User/File.txt'));
  });
});
