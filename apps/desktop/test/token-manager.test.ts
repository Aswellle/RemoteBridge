import { describe, it, expect, vi, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// `var` (not `let`/`const`): vi.mock factories are hoisted above the rest of
// this file, so the binding must already exist (not in a `let` TDZ) when it runs.
var testDataDir = '';

// db/client.ts resolves its SQLite location via Electron's app.getPath('userData')
// at module-load time. Mock just enough of `electron` to point it at a throwaway dir.
vi.mock('electron', () => ({
  app: {
    getPath: () => {
      testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-token-test-'));
      return testDataDir;
    },
  },
}));

import { db, initDatabase } from '../src/main/db/client';
import {
  createDownloadToken,
  validateDownloadToken,
  markTokenUsed,
  cleanExpiredTokens,
} from '../src/main/file-server/token-manager';

// initDatabase() is no longer called automatically on module load (P3-9c) —
// tests must create the schema themselves before running queries.
initDatabase();

afterAll(() => {
  if (testDataDir) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
});

describe('validateDownloadToken', () => {
  it('returns TOKEN_NOT_FOUND for an unknown token', () => {
    expect(validateDownloadToken('does-not-exist')).toEqual({
      valid: false,
      reason: 'TOKEN_NOT_FOUND',
    });
  });

  it('validates a freshly created token', () => {
    const { token } = createDownloadToken('/shared/docs/report.pdf', 'client-1');
    const result = validateDownloadToken(token, 'client-1');

    expect(result.valid).toBe(true);
    expect(result.token?.filePath).toBe('/shared/docs/report.pdf');
    expect(result.token?.clientId).toBe('client-1');
    expect(result.token?.downloadCount).toBe(0);
  });

  it('skips the client check when no clientId is provided', () => {
    const { token } = createDownloadToken('/shared/docs/anon.pdf', 'client-1');
    expect(validateDownloadToken(token).valid).toBe(true);
  });

  it('returns CLIENT_MISMATCH when validated by a different client', () => {
    const { token } = createDownloadToken('/shared/docs/shared.pdf', 'client-1');
    expect(validateDownloadToken(token, 'client-2')).toEqual({
      valid: false,
      reason: 'CLIENT_MISMATCH',
    });
  });

  it('returns TOKEN_USED once download_count >= 1', () => {
    const { token } = createDownloadToken('/shared/docs/once.pdf', 'client-1');
    markTokenUsed(token);
    expect(validateDownloadToken(token)).toEqual({ valid: false, reason: 'TOKEN_USED' });
  });

  it('returns TOKEN_EXPIRED for a token past its expiry', () => {
    const { token } = createDownloadToken('/shared/docs/old.pdf', 'client-1', -1000);
    expect(validateDownloadToken(token)).toEqual({ valid: false, reason: 'TOKEN_EXPIRED' });
  });
});

describe('cleanExpiredTokens', () => {
  it('removes only expired tokens', () => {
    const expired = createDownloadToken('/shared/docs/expired.pdf', 'client-1', -1000);
    const valid = createDownloadToken('/shared/docs/valid.pdf', 'client-1');

    const removed = cleanExpiredTokens();

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(db.getDownloadToken(expired.token)).toBeUndefined();
    expect(db.getDownloadToken(valid.token)).toBeDefined();
  });
});
