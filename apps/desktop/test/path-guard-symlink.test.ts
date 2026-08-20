import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { symlinkSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { validatePath } from '../src/main/security/path-guard';

// On Windows, %LOCALAPPDATA% (which contains os.tmpdir()) is system-protected.
// Use a base directory outside the system blocked list so paths resolve cleanly.
// Prefer a path on a non-system drive; fall back to a sibling of the home dir.
function pickSafeBase(): string {
  // D:\ exists on this dev box and is outside all system blocked dirs.
  const dDrive = 'D:\\rb-test-tmp';
  try {
    mkdirSync(dDrive, { recursive: true });
    return dDrive;
  } catch {
    // Fall back to a subdir of the user's home (not under AppData).
    return path.join(os.homedir(), 'rb-test-tmp');
  }
}
const SAFE_BASE = pickSafeBase();

// Symlink creation on Windows may require elevated privileges or Developer Mode.
// Probe once at module load and skip the whole file if unsupported.
let symlinksSupported = false;
let probeDir = '';
try {
  probeDir = fs.mkdtempSync(path.join(SAFE_BASE, 'rb-symlink-probe-'));
  const target = path.join(probeDir, 'target');
  const link = path.join(probeDir, 'link');
  mkdirSync(target);
  symlinkSync(target, link, 'junction');
  symlinksSupported = fs.existsSync(link);
} catch {
  symlinksSupported = false;
} finally {
  if (probeDir) rmSync(probeDir, { recursive: true, force: true });
}

let baseDir = '';
let allowedDir = '';
let outsideDir = '';
let symlinkPath = '';

describe.skipIf(!symlinksSupported)('validatePath — symlink resolution (SEC: symlink escape)', () => {
  beforeAll(() => {
    baseDir = fs.mkdtempSync(path.join(SAFE_BASE, 'rb-symlink-test-'));
    allowedDir = path.join(baseDir, 'whitelisted');
    outsideDir = path.join(baseDir, 'outside');
    mkdirSync(allowedDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    // Create a secret file OUTSIDE the whitelist — must never be reachable.
    writeFileSync(path.join(outsideDir, 'secret.txt'), 'top-secret');

    // Symlink inside the whitelisted dir that points outside.
    symlinkPath = path.join(allowedDir, 'leak');
    symlinkSync(outsideDir, symlinkPath, 'junction');
  });

  afterAll(() => {
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  });

  const allowedDirs = [
    { id: 1, path: '/whitelisted', permission: 'download' as const, recursive: true, is_active: true },
  ];

  it('resolves a symlink and denies access to its real target outside the whitelist', () => {
    const requestedPath = path.join(symlinkPath, 'secret.txt');
    const result = validatePath(requestedPath, allowedDirs);
    expect(result).toEqual({ allowed: false, reason: 'NOT_IN_WHITELIST' });
  });

  it('allows access to a real file inside the whitelisted directory', () => {
    // Whitelist path matches the real directory via path.resolve equivalence:
    // normalize both to the same absolute path the guard resolves.
    const allowedDirResolved = path.resolve(allowedDir);
    const realFile = path.join(allowedDir, 'ok.txt');
    writeFileSync(realFile, 'safe');
    const dirs = [{ id: 1, path: allowedDirResolved, permission: 'download' as const, recursive: true, is_active: true }];
    expect(validatePath(realFile, dirs)).toEqual({ allowed: true });
  });

  it('allows access through a symlink whose real target is INSIDE the whitelist', () => {
    // Symlink inside whitelist → points to another location inside whitelist.
    const inner = path.join(allowedDir, 'inner');
    mkdirSync(inner, { recursive: true });
    const safeLink = path.join(allowedDir, 'safe-link');
    symlinkSync(inner, safeLink, 'junction');
    const requestedPath = path.join(safeLink, 'file.txt');
    const allowedDirResolved = path.resolve(allowedDir);
    const dirs = [{ id: 1, path: allowedDirResolved, permission: 'download' as const, recursive: true, is_active: true }];
    expect(validatePath(requestedPath, dirs)).toEqual({ allowed: true });
  });

  it('blocks a chain of nested symlinks that eventually escape the whitelist', () => {
    // inner → outside (escape), accessed from within allowedDir.
    const chainLink = path.join(allowedDir, 'chain');
    symlinkSync(outsideDir, chainLink, 'junction');
    const requestedPath = path.join(chainLink, 'secret.txt');
    const result = validatePath(requestedPath, allowedDirs);
    expect(result).toEqual({ allowed: false, reason: 'NOT_IN_WHITELIST' });
  });
});

// Graceful skip message when symlinks can't be created on this platform.
describe('validatePath — symlink resolution', () => {
  it('skip notice: symlinks not creatable on this platform', () => {
    if (symlinksSupported) {
      expect(true).toBe(true);
      return;
    }
    console.warn(
      'SKIP: symlink tests skipped — fs.symlinkSync failed (Windows requires elevated privileges or Developer Mode).',
    );
    expect(symlinksSupported).toBe(false);
  });
});
