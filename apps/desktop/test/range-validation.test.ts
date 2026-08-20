import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Reuse the same mock pattern as file-server.test.ts — keep them isolated
// (this file starts its own server instance on a fresh port).
const mocks = vi.hoisted(() => ({
  validateDownloadToken: vi.fn(),
  markTokenUsed: vi.fn(),
  insertAccessLog: vi.fn(),
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/main/db/client', () => ({
  db: {
    getAllowedDirectories: () =>
      testDir ? [{ id: 1, path: testDir, permission: 'download', recursive: true, is_active: 1 }] : [],
    insertAccessLog: mocks.insertAccessLog,
  },
}));

vi.mock('../src/main/file-server/token-manager', () => ({
  validateDownloadToken: mocks.validateDownloadToken,
  markTokenUsed: mocks.markTokenUsed,
}));

vi.mock('../src/main/security/path-guard', () => ({
  validatePath: (filePath: string) => ({
    allowed: Boolean(testDir && filePath.startsWith(testDir)),
    reason: undefined,
  }),
}));

import { startFileServer, stopFileServer } from '../src/main/file-server/server';

var testDir = '';
var testFilePath = '';
let port = 0;

const FILE_SIZE = 100; // we write exactly 100 bytes; valid range is 0..99

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-range-test-'));
  testFilePath = path.join(testDir, 'data.bin');
  // Deterministic 100-byte payload.
  const buf = Buffer.alloc(FILE_SIZE, 0x61); // 'a' * 100
  fs.writeFileSync(testFilePath, buf);
  port = await startFileServer();
});

afterAll(async () => {
  await stopFileServer();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.validateDownloadToken.mockReset();
  mocks.markTokenUsed.mockReset();
  mocks.insertAccessLog.mockReset();
});

function get(endpoint: string, headers?: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${endpoint}`, { headers });
}

function allowToken(filePath: string, clientId = 'c1') {
  mocks.validateDownloadToken.mockReturnValueOnce({
    valid: true,
    token: { filePath, clientId },
  });
}

describe('/download — Range validation (TST-H4 / D4)', () => {
  it('returns 416 when start is NaN (non-numeric Range)', async () => {
    allowToken(testFilePath);
    const res = await get('/download?token=nan-start', { Range: 'bytes=abc-10' });
    expect(res.status).toBe(416);
  });

  it('returns 416 when end >= fileSize (exclusive upper bound)', async () => {
    allowToken(testFilePath);
    // file is 100 bytes → max valid end is 99
    const res = await get('/download?token=end-too-big', { Range: `bytes=0-${FILE_SIZE}` });
    expect(res.status).toBe(416);
  });

  it('returns 416 when end is just past the last byte', async () => {
    allowToken(testFilePath);
    const res = await get('/download?token=end-past', { Range: 'bytes=0-100' });
    expect(res.status).toBe(416);
  });

  it('returns 416 when start > end (inverted range)', async () => {
    allowToken(testFilePath);
    const res = await get('/download?token=inverted', { Range: 'bytes=50-10' });
    expect(res.status).toBe(416);
  });

  it('returns 416 when start is negative (parseInt parses leading digits but value < 0)', async () => {
    allowToken(testFilePath);
    // "-5" → parseInt("-5") = -5, which fails start < 0
    const res = await get('/download?token=neg-start', { Range: 'bytes=-5-10' });
    expect(res.status).toBe(416);
  });

  it('returns 206 with Content-Range for a valid byte range', async () => {
    allowToken(testFilePath);
    const res = await get('/download?token=valid', { Range: 'bytes=0-4' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-4/${FILE_SIZE}`);
    expect(res.headers.get('content-length')).toBe('5');
    expect(await res.text()).toHaveLength(5);
  });

  it('returns 206 for an open-ended range (bytes=N-)', async () => {
    allowToken(testFilePath);
    const res = await get('/download?token=open', { Range: 'bytes=95-' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 95-99/${FILE_SIZE}`);
    expect(await res.text()).toHaveLength(5);
  });

  it('returns 206 for the last single byte (start == end == size-1)', async () => {
    allowToken(testFilePath);
    const res = await get('/download?token=last-byte', { Range: `bytes=${FILE_SIZE - 1}-${FILE_SIZE - 1}` });
    expect(res.status).toBe(206);
    expect(await res.text()).toHaveLength(1);
  });
});

describe('/preview — Range validation (TST-H4 / D4)', () => {
  it('returns 416 for an invalid Range on /preview', async () => {
    allowToken(testFilePath);
    const res = await get('/preview?token=bad-range', { Range: 'bytes=10-5' });
    expect(res.status).toBe(416);
  });

  it('returns 206 for a valid Range on /preview', async () => {
    allowToken(testFilePath);
    const res = await get('/preview?token=good-range', { Range: 'bytes=0-9' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-9/${FILE_SIZE}`);
  });
});
