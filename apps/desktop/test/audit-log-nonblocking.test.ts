import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { WSMessageType } from '@remotebridge/shared';

// Captured outbound WS messages.
var sentMessages: unknown[] = [];
// Registered WS event handlers, keyed by message type.
var handlers = new Map<string, (payload: unknown) => Promise<void> | void>();
var allowedDir = '';

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { send: vi.fn() };
  },
}));

// KEY MOCK: logAccess never resolves. If any handler `await`s it, the emit
// promise will hang forever and the test will time out — proving the audit
// write is fire-and-forget.
vi.mock('../src/main/security/audit-logger', () => ({
  logAccess: () => new Promise(() => {}),
  logSecurity: () => new Promise(() => {}),
}));

// Mock path-guard so this test focuses on audit behavior, not path logic.
vi.mock('../src/main/security/path-guard', () => ({
  validatePath: () => ({ allowed: true }),
}));

vi.mock('../src/main/ws-client/client', () => ({
  getRelayClient: () => ({
    on: (type: string, handler: (payload: unknown) => Promise<void> | void) => {
      handlers.set(type, handler);
    },
    send: (msg: unknown) => { sentMessages.push(msg); return true; },
    isConnected: () => true,
  }),
}));

vi.mock('../src/main/db/client', () => ({
  default: {
    getAllowedDirectories: () => [
      { id: 1, path: allowedDir, permission: 'download', recursive: true, is_active: 1 },
    ],
  },
}));

import { setupDirWsHandlers, invalidateAllowedDirsCache } from '../src/main/ws-client/dir-handlers';

async function emit(type: string, payload: Record<string, unknown>) {
  const handler = handlers.get(type);
  if (!handler) throw new Error(`Handler not registered for ${type}`);
  return handler(payload);
}

// Type guard helpers — narrow the unknown WS message before reading fields.
function isWsMessage(value: unknown): value is { type: string; payload: Record<string, unknown> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string' &&
    'payload' in value &&
    typeof (value as { payload: unknown }).payload === 'object' &&
    (value as { payload: unknown }).payload !== null
  );
}

function findMessage(type: string) {
  return sentMessages.find(
    (m): m is { type: string; payload: Record<string, unknown> } => isWsMessage(m) && m.type === type,
  );
}

beforeAll(() => {
  allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-audit-test-'));
  // Ensure the cache is fresh so getCachedAllowedDirs hits our mock db.
  invalidateAllowedDirsCache();
  setupDirWsHandlers(null);
});

afterAll(() => {
  if (allowedDir) fs.rmSync(allowedDir, { recursive: true, force: true });
});

beforeEach(() => {
  sentMessages = [];
  invalidateAllowedDirsCache();
});

describe('logAccess — fire-and-forget (does not block WS response)', () => {
  it('CMD_LIST_ALLOWED sends RESP_DIR_LIST immediately even when logAccess hangs', async () => {
    const t0 = Date.now();
    await emit(WSMessageType.CMD_LIST_ALLOWED as string, {
      requestId: 'req-1',
      clientId: 'c1',
      sessionId: 's1',
    });
    const elapsed = Date.now() - t0;

    // The audit write hangs forever; if awaited, this emit would never resolve.
    // Resolving in < 1s on a cold machine proves the handler did not block.
    expect(elapsed).toBeLessThan(1000);

    const list = findMessage(WSMessageType.RESP_DIR_LIST as string);
    expect(list).toBeDefined();
    expect(list?.payload?.requestId).toBe('req-1');
    expect(Array.isArray(list?.payload?.entries)).toBe(true);
  });

  it('CMD_LIST_DIR sends RESP_DIR_LIST without awaiting the audit write', async () => {
    // allowedDir is a real, readable directory — fs.stat succeeds.
    const t0 = Date.now();
    await emit(WSMessageType.CMD_LIST_DIR as string, {
      path: allowedDir,
      requestId: 'req-2',
      clientId: 'c1',
      sessionId: 's1',
    });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(1000);

    const list = findMessage(WSMessageType.RESP_DIR_LIST as string);
    expect(list).toBeDefined();
    expect(list?.payload?.requestId).toBe('req-2');
    expect(Array.isArray(list?.payload?.entries)).toBe(true);
  });

  it('CMD_REQUEST_DOWNLOAD on a whitelisted-but-missing file returns RESP_DOWNLOAD_ERROR promptly', async () => {
    // File does not exist → handler hits the catch path and returns an error.
    // logAccess is still called in the happy path; here we verify the error
    // path is also non-blocking.
    const missing = path.join(allowedDir, 'does-not-exist.bin');
    const t0 = Date.now();
    await emit(WSMessageType.CMD_REQUEST_DOWNLOAD as string, {
      filePath: missing,
      requestId: 'req-3',
      clientId: 'c1',
      sessionId: 's1',
    });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(1000);

    const err = findMessage(WSMessageType.RESP_DOWNLOAD_ERROR as string);
    expect(err).toBeDefined();
    expect(err?.payload?.requestId).toBe('req-3');
  });
});
