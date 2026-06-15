import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import { getBlockedDirsForPlatform, SYSTEM_BLOCKED_DIRS } from '@remotebridge/shared';
import { validatePath, isSystemDirectory } from '../src/main/security/path-guard';

const allowedDirs = [
  { id: 1, path: '/shared/docs', permission: 'download' as const, recursive: true, is_active: true },
  { id: 2, path: '/shared/readonly', permission: 'readonly' as const, recursive: false, is_active: true },
];

describe('validatePath', () => {
  it('allows a path inside a recursive whitelist entry', () => {
    const result = validatePath('/shared/docs/sub/file.txt', allowedDirs);
    expect(result).toEqual({ allowed: true });
  });

  it('allows the whitelist entry itself', () => {
    const result = validatePath('/shared/docs', allowedDirs);
    expect(result).toEqual({ allowed: true });
  });

  it('rejects a path outside the whitelist', () => {
    const result = validatePath('/other/place', allowedDirs);
    expect(result).toEqual({ allowed: false, reason: 'NOT_IN_WHITELIST' });
  });

  it('rejects a sibling directory sharing a name prefix', () => {
    const result = validatePath('/shared/docs2/file.txt', allowedDirs);
    expect(result).toEqual({ allowed: false, reason: 'NOT_IN_WHITELIST' });
  });

  it('rejects a subdirectory of a non-recursive whitelist entry', () => {
    const result = validatePath('/shared/readonly/sub', allowedDirs);
    expect(result).toEqual({ allowed: false, reason: 'NOT_IN_WHITELIST' });
  });

  it('allows a non-recursive whitelist entry itself', () => {
    const result = validatePath('/shared/readonly', allowedDirs);
    expect(result).toEqual({ allowed: true });
  });

  it('ignores inactive whitelist entries', () => {
    const inactive = [{ id: 3, path: '/shared/inactive', permission: 'readonly' as const, recursive: true, is_active: false }];
    const result = validatePath('/shared/inactive/file.txt', inactive);
    expect(result).toEqual({ allowed: false, reason: 'NOT_IN_WHITELIST' });
  });
});

describe('isSystemDirectory', () => {
  it('flags a directory from the current platform\'s system blacklist', () => {
    const platform = os.platform() as 'win32' | 'darwin' | 'linux';
    const [firstBlocked] = getBlockedDirsForPlatform(platform);
    expect(isSystemDirectory(firstBlocked)).toBe(true);
    expect(isSystemDirectory(path.join(firstBlocked, 'sub'))).toBe(true);
  });

  it('does not flag an ordinary whitelisted directory', () => {
    expect(isSystemDirectory('/shared/docs')).toBe(false);
  });
});

// P0-12 regression: path-guard must resolve %APPDATA%/%LOCALAPPDATA% via
// getBlockedDirsForPlatform(), not just the static SYSTEM_BLOCKED_DIRS.win32 list.
describe.skipIf(os.platform() !== 'win32' || !process.env.APPDATA)('P0-12 regression (win32 %APPDATA%)', () => {
  it('blocks %APPDATA% even though it is absent from the static blacklist', () => {
    const appData = process.env.APPDATA as string;
    expect(SYSTEM_BLOCKED_DIRS.win32).not.toContain(appData);

    expect(isSystemDirectory(appData)).toBe(true);
    expect(validatePath(appData, [])).toEqual({ allowed: false, reason: 'SYSTEM_PROTECTED' });
    expect(validatePath(path.join(appData, 'secrets.txt'), [])).toEqual({
      allowed: false,
      reason: 'SYSTEM_PROTECTED',
    });
  });
});
