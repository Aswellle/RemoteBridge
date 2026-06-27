import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// var: hoisted above imports, read at test-execution time (not at factory time)
var testDir = '';
var testFilePath = '';

// vi.hoisted: these vi.fn() instances exist during the hoist phase so
// vi.mock factories can reference them safely
const mocks = vi.hoisted(() => ({
  validateDownloadToken: vi.fn(),
  markTokenUsed: vi.fn(),
  insertAccessLog: vi.fn(),
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock the db — server.ts only calls getAllowedDirectories and insertAccessLog
vi.mock('../src/main/db/client', () => ({
  db: {
    getAllowedDirectories: () =>
      testDir ? [{ id: 1, path: testDir, permission: 'download', recursive: true, is_active: 1 }] : [],
    insertAccessLog: mocks.insertAccessLog,
  },
}));

// Mock token-manager so we can control validation outcomes per-test
vi.mock('../src/main/file-server/token-manager', () => ({
  validateDownloadToken: mocks.validateDownloadToken,
  markTokenUsed: mocks.markTokenUsed,
}));

// Mock path-guard — allow anything inside testDir, deny everything else
vi.mock('../src/main/security/path-guard', () => ({
  validatePath: (filePath: string) => ({
    allowed: Boolean(testDir && filePath.startsWith(testDir)),
    reason: undefined,
  }),
}));

import { startFileServer, stopFileServer } from '../src/main/file-server/server';

let port = 0;

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-fserver-test-'));
  testFilePath = path.join(testDir, 'sample.txt');
  fs.writeFileSync(testFilePath, 'Hello, World! This is test content.');
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

// Helper: configure a passing token returning a specific filePath
function allowToken(filePath: string, clientId = 'c1') {
  mocks.validateDownloadToken.mockReturnValueOnce({
    valid: true,
    token: { filePath, clientId },
  });
}

function denyToken(reason: 'TOKEN_NOT_FOUND' | 'TOKEN_EXPIRED' | 'TOKEN_USED') {
  mocks.validateDownloadToken.mockReturnValueOnce({ valid: false, reason });
}

// ===== /download =====

describe('/download — token validation (TST-H4)', () => {
  it('returns 400 when token query param is absent', async () => {
    const res = await get('/download');
    expect(res.status).toBe(400);
  });

  it('returns 401 for TOKEN_NOT_FOUND', async () => {
    denyToken('TOKEN_NOT_FOUND');
    const res = await get('/download?token=unknown');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('TOKEN_NOT_FOUND');
  });

  it('returns 401 for TOKEN_EXPIRED', async () => {
    denyToken('TOKEN_EXPIRED');
    const res = await get('/download?token=old');
    expect(res.status).toBe(401);
  });

  it('returns 401 for TOKEN_USED', async () => {
    denyToken('TOKEN_USED');
    const res = await get('/download?token=used');
    expect(res.status).toBe(401);
  });

  it('returns 404 when the file does not exist', async () => {
    mocks.validateDownloadToken.mockReturnValueOnce({
      valid: true,
      token: { filePath: path.join(testDir, 'ghost.txt'), clientId: 'c1' },
    });
    const res = await get('/download?token=ghost');
    expect(res.status).toBe(404);
    // token should NOT be consumed when the file is missing (SEC-M1 order-of-operations fix)
    expect(mocks.markTokenUsed).not.toHaveBeenCalled();
  });

  it('returns 200, streams full file, and sets Content-Disposition', async () => {
    allowToken(testFilePath);
    const res = await get('/download?token=ok');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Hello, World! This is test content.');
    expect(res.headers.get('content-disposition')).toContain('sample.txt');
    expect(mocks.markTokenUsed).toHaveBeenCalledOnce();
  });

  it('marks token used only after confirming file exists', async () => {
    allowToken(testFilePath);
    await get('/download?token=order');
    // markTokenUsed must be called after statFile succeeds
    expect(mocks.markTokenUsed).toHaveBeenCalledOnce();
  });
});

describe('/download — Range requests', () => {
  it('returns 206 with Content-Range for a byte range', async () => {
    allowToken(testFilePath);
    const res = await get('/download?token=range', { Range: 'bytes=0-4' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-4\//);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toBe('Hello');
  });

  it('returns the tail of the file with an open-ended range (bytes=N-)', async () => {
    const content = 'Hello, World! This is test content.';
    const offset = 7; // "World! This is test content."
    allowToken(testFilePath);
    const res = await get('/download?token=tail', { Range: `bytes=${offset}-` });
    expect(res.status).toBe(206);
    const text = await res.text();
    expect(text).toBe(content.slice(offset));
  });
});

describe('/download — access log', () => {
  it('writes an access log entry on successful download', async () => {
    allowToken(testFilePath, 'audit-client');
    await get('/download?token=audit');
    expect(mocks.insertAccessLog).toHaveBeenCalledOnce();
    expect(mocks.insertAccessLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DOWNLOAD', status: 'OK' }),
    );
  });

  it('does NOT write an access log when token is invalid', async () => {
    denyToken('TOKEN_NOT_FOUND');
    await get('/download?token=bad-audit');
    expect(mocks.insertAccessLog).not.toHaveBeenCalled();
  });
});

// ===== /preview =====

describe('/preview — MIME types', () => {
  const cases: [string, string][] = [
    ['test.txt', 'text/plain'],
    ['test.pdf', 'application/pdf'],
    ['test.png', 'image/png'],
    ['test.json', 'application/json'],
    ['test.md', 'text/markdown'],
    ['test.html', 'text/html'],
    ['unknown.xyz', 'application/octet-stream'],
  ];

  for (const [filename, expectedMime] of cases) {
    it(`serves ${filename} as ${expectedMime}`, async () => {
      const fp = path.join(testDir, filename);
      fs.writeFileSync(fp, 'data');
      mocks.validateDownloadToken.mockReturnValueOnce({
        valid: true,
        token: { filePath: fp, clientId: 'c1' },
      });
      const res = await get(`/preview?token=mime-${filename}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain(expectedMime);
    });
  }

  it('sets Cache-Control: no-store for previews', async () => {
    allowToken(testFilePath);
    const res = await get('/preview?token=cc');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('/preview — Range requests', () => {
  it('returns 206 for a Range request on preview', async () => {
    allowToken(testFilePath);
    const res = await get('/preview?token=prange', { Range: 'bytes=0-4' });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('Hello');
  });
});
