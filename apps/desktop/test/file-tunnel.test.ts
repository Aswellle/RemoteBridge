import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WSMessageType } from '@remotebridge/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// vi.mock factories are hoisted above imports; `var` avoids TDZ issues since
// the factories' closures read these at call time, not at definition time.
var sentMessages: any[] = [];
var bufferedAmountQueue: number[] = [];
var isConnectedValue = true;
var handlers = new Map<string, (payload: any) => Promise<void> | void>();
var testDir = '';
var testFilePath = '';

vi.mock('../src/main/ws-client/client', () => ({
  getRelayClient: () => ({
    on: (type: string, handler: (payload: any) => Promise<void> | void) => {
      handlers.set(type, handler);
    },
    send: (message: any) => {
      sentMessages.push(message);
      return true;
    },
    isConnected: () => isConnectedValue,
    getBufferedAmount: () => (bufferedAmountQueue.length > 0 ? bufferedAmountQueue.shift()! : 0),
  }),
}));

vi.mock('../src/main/db/client', () => ({
  default: {
    getAllowedDirectories: () => [
      { id: 1, path: testDir, permission: 'download', recursive: true, is_active: true },
    ],
  },
}));

vi.mock('../src/main/security/audit-logger', () => ({
  logAccess: vi.fn(async () => {}),
}));

vi.mock('../src/main/file-server/token-manager', () => ({
  validateDownloadToken: vi.fn((token: string) => {
    if (token === 'valid-token') {
      return { valid: true, token: { filePath: testFilePath, clientId: 'client-1' } };
    }
    return { valid: false, reason: 'TOKEN_NOT_FOUND' };
  }),
  markTokenUsed: vi.fn(),
}));

vi.mock('../src/main/file-server/server', () => ({
  getContentTypeForExt: () => 'application/octet-stream',
}));

import { setupFileTunnelHandler } from '../src/main/ws-client/file-tunnel';

// > CHUNK_SIZE (256KB) so the stream yields multiple RESP_FILE_CHUNK frames.
const FILE_SIZE = 600 * 1024;
const BACKPRESSURE_HIGH_WATER = 4 * 1024 * 1024;

describe('setupFileTunnelHandler / CMD_FETCH_FILE backpressure', () => {
  beforeAll(() => {
    // Placed inside the project tree (not os.tmpdir()) — on Windows, os.tmpdir()
    // resolves under %LOCALAPPDATA%, which validatePath's system blacklist rejects.
    testDir = fs.mkdtempSync(path.join(__dirname, 'tmp-file-tunnel-'));
    testFilePath = path.join(testDir, 'test-file.bin');
    const data = Buffer.alloc(FILE_SIZE);
    for (let i = 0; i < FILE_SIZE; i++) data[i] = i % 256;
    fs.writeFileSync(testFilePath, data);

    setupFileTunnelHandler();
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    sentMessages = [];
    bufferedAmountQueue = [];
    isConnectedValue = true;
  });

  it('waits for the send buffer to drain before sending chunks, then streams the full file', async () => {
    // First two backpressure checks report a full buffer; the third reports drained.
    bufferedAmountQueue = [BACKPRESSURE_HIGH_WATER + 1, BACKPRESSURE_HIGH_WATER + 1, 0];

    const handler = handlers.get(WSMessageType.CMD_FETCH_FILE);
    expect(handler).toBeDefined();

    const started = Date.now();
    await handler!({ transferId: 'transfer-1', token: 'valid-token' });
    const elapsed = Date.now() - started;

    // Two 50ms polls must elapse before the first chunk can be sent.
    expect(elapsed).toBeGreaterThanOrEqual(90);

    const chunks = sentMessages.filter((m) => m.type === WSMessageType.RESP_FILE_CHUNK);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    chunks.forEach((c, i) => expect(c.payload.seq).toBe(i));
    expect(chunks[0].payload.totalSize).toBe(FILE_SIZE);
    expect(chunks[chunks.length - 1].payload.eof).toBe(true);
    chunks.slice(0, -1).forEach((c) => expect(c.payload.eof).toBe(false));

    const rebuilt = Buffer.concat(chunks.map((c) => Buffer.from(c.payload.data, 'base64')));
    expect(rebuilt.equals(fs.readFileSync(testFilePath))).toBe(true);

    expect(sentMessages.some((m) => m.type === WSMessageType.RESP_FILE_ERROR)).toBe(false);
  });

  it('aborts the transfer without sending any chunks if the connection drops while backpressured', async () => {
    // Buffer never drains, and the connection is reported as closed.
    bufferedAmountQueue = [BACKPRESSURE_HIGH_WATER + 1];
    isConnectedValue = false;

    const handler = handlers.get(WSMessageType.CMD_FETCH_FILE);
    await handler!({ transferId: 'transfer-2', token: 'valid-token' });

    expect(sentMessages.filter((m) => m.type === WSMessageType.RESP_FILE_CHUNK)).toHaveLength(0);
    expect(sentMessages.filter((m) => m.type === WSMessageType.RESP_FILE_ERROR)).toHaveLength(0);
  });
});
