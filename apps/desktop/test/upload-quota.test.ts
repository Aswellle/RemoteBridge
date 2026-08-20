import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { WSMessageType } from '@remotebridge/shared';

// Isolated module state: this file re-mocks the same modules as handlers.test.ts
// but runs in its own vitest module registry, so uploadBuffer starts empty.
var sentMessages: any[] = [];
var handlers = new Map<string, (payload: any) => Promise<void> | void>();
var testUploadDir = '';

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { send: vi.fn() };
  },
  Notification: class {
    static isSupported() { return false; }
    show() {}
  },
}));

vi.mock('../src/main/ws-client/client', () => ({
  getRelayClient: () => ({
    on: (type: string, handler: (payload: any) => Promise<void> | void) => {
      handlers.set(type, handler);
    },
    send: (msg: any) => { sentMessages.push(msg); return true; },
    isConnected: () => true,
  }),
}));

vi.mock('../src/main/db/client', () => ({
  db: {
    insertMessage: vi.fn(),
    upsertConnectedClient: vi.fn(),
  },
}));

vi.mock('../src/main/config/store', () => ({
  config: { getUploadPaths: vi.fn(() => null) },
  getDefaultUploadPaths: async () => ({
    images:    path.join(testUploadDir, 'images'),
    videos:    path.join(testUploadDir, 'videos'),
    documents: path.join(testUploadDir, 'documents'),
    archives:  path.join(testUploadDir, 'archives'),
    markdown:  path.join(testUploadDir, 'markdown'),
  }),
}));

import { setupMessageHandlers } from '../src/main/ws-client/handlers';

async function emitChunk(payload: Record<string, unknown>) {
  const handler = handlers.get(WSMessageType.CMD_UPLOAD_FILE_CHUNK as string);
  if (!handler) throw new Error('CMD_UPLOAD_FILE_CHUNK handler not registered');
  return handler(payload);
}

// 100 MB + 1 byte — one byte over the per-file cap.
const OVER_FILE_CAP = 100 * 1024 * 1024 + 1;

beforeAll(() => {
  testUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-upload-quota-'));
  setupMessageHandlers(null);
});

afterAll(() => {
  if (testUploadDir) fs.rmSync(testUploadDir, { recursive: true, force: true });
});

beforeEach(() => {
  sentMessages = [];
});

describe('CMD_UPLOAD_FILE_CHUNK — quota enforcement (PH1 / SEC-H1)', () => {
  it('rejects a chunk whose actual size exceeds the 100 MB per-file cap even when totalSize=1', async () => {
    // Attacker lies: totalSize=1, but the base64 payload decodes to >100 MB.
    // SEC-H1: the guard measures actualBytes, not the declared totalSize.
    const hugeBuf = Buffer.alloc(OVER_FILE_CAP, 0x62); // 100 MB + 1 of 'b'
    const data = hugeBuf.toString('base64');

    await emitChunk({
      uploadId: 'uid-over-cap',
      chunkIndex: 0, totalChunks: 1,
      fileName: 'big.bin', mimeType: 'application/octet-stream', category: 'documents',
      totalSize: 1, // lie: claim it's tiny
      data,
      clientId: 'c1', sessionId: 's1',
    });

    const quotaErrors = sentMessages.filter(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ERROR && m.payload.code === 'QUOTA_EXCEEDED',
    );
    expect(quotaErrors).toHaveLength(1);
    expect(quotaErrors[0].payload.uploadId).toBe('uid-over-cap');

    // No ACK must be emitted — the file was never persisted.
    const acks = sentMessages.filter((m) => m.type === WSMessageType.RESP_UPLOAD_ACK);
    expect(acks).toHaveLength(0);
  });

  it('accepts a chunk right at the 100 MB boundary (exactly MAX_FILE_BYTES)', async () => {
    // Boundary: exactly 100 MB is allowed (the check is `> MAX_FILE_BYTES`).
    const exactBuf = Buffer.alloc(100 * 1024 * 1024, 0x63);
    const data = exactBuf.toString('base64');

    await emitChunk({
      uploadId: 'uid-exact-cap',
      chunkIndex: 0, totalChunks: 1,
      fileName: 'exact.bin', mimeType: 'application/octet-stream', category: 'documents',
      totalSize: 100 * 1024 * 1024,
      data,
      clientId: 'c1', sessionId: 's1',
    });

    const acks = sentMessages.filter(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ACK && m.payload.uploadId === 'uid-exact-cap',
    );
    expect(acks).toHaveLength(1);
  });

  it('blocks the 6th concurrent upload once MAX_CONCURRENT_UPLOADS (5) is reached', async () => {
    // Each upload has totalChunks=2 but we only send chunk 0, so the transfer
    // stays in the buffer (incomplete) and counts toward the concurrency cap.
    const tiny = Buffer.from('x').toString('base64');

    for (let i = 0; i < 5; i++) {
      await emitChunk({
        uploadId: `uid-concurrent-${i}`,
        chunkIndex: 0, totalChunks: 2, // leave incomplete so it stays buffered
        fileName: `f${i}.txt`, mimeType: 'text/plain', category: 'documents',
        totalSize: 1, data: tiny,
        clientId: 'c1', sessionId: 's1',
      });
    }

    // None of the 5 should have been rejected.
    const earlyErrors = sentMessages.filter(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ERROR && m.payload.code === 'QUOTA_EXCEEDED',
    );
    expect(earlyErrors).toHaveLength(0);

    // 6th upload — must be rejected with QUOTA_EXCEEDED.
    await emitChunk({
      uploadId: 'uid-concurrent-5',
      chunkIndex: 0, totalChunks: 1,
      fileName: 'f5.txt', mimeType: 'text/plain', category: 'documents',
      totalSize: 1, data: tiny,
      clientId: 'c1', sessionId: 's1',
    });

    const quotaErrors = sentMessages.filter(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ERROR && m.payload.code === 'QUOTA_EXCEEDED',
    );
    expect(quotaErrors).toHaveLength(1);
    expect(quotaErrors[0].payload.uploadId).toBe('uid-concurrent-5');

    // CLEANUP: complete the 5 buffered uploads so the module-level buffer is
    // empty for subsequent tests. Sending chunk 1 of 2 finalizes each transfer.
    for (let i = 0; i < 5; i++) {
      await emitChunk({
        uploadId: `uid-concurrent-${i}`,
        chunkIndex: 1, totalChunks: 2,
        fileName: `f${i}.txt`, mimeType: 'text/plain', category: 'documents',
        totalSize: 1, data: tiny,
        clientId: 'c1', sessionId: 's1',
      });
    }
  });

  it('rejects a chunk that would push total buffered bytes over the 500 MB global cap', async () => {
    // 5 files, each incomplete at 100 MB (totalChunks=2, only chunk 0 sent).
    // totalBufferedBytes = 500 MB. Adding any further chunk to any file must be
    // rejected with QUOTA_EXCEEDED — the per-chunk cap check fires even though
    // the per-file cap (100 MB) is the binding constraint here.
    const hundredMB = Buffer.alloc(100 * 1024 * 1024, 0x65).toString('base64');
    const tiny = Buffer.from('y').toString('base64');

    for (let i = 0; i < 5; i++) {
      await emitChunk({
        uploadId: `uid-gcap-${i}`,
        chunkIndex: 0, totalChunks: 2, // incomplete: stays in buffer
        fileName: `gc${i}.bin`, mimeType: 'application/octet-stream', category: 'documents',
        totalSize: 100 * 1024 * 1024, data: hundredMB,
        clientId: 'c1', sessionId: 's1',
      });
    }

    // Buffer now holds 5 files × 100 MB = 500 MB. Any additional chunk must be
    // rejected by the per-chunk quota guard (totalBufferedBytes + chunk > 500 MB,
    // or per-file actualBytes + chunk > 100 MB).
    await emitChunk({
      uploadId: 'uid-gcap-0',
      chunkIndex: 1, totalChunks: 2,
      fileName: 'gc0.bin', mimeType: 'application/octet-stream', category: 'documents',
      totalSize: 100 * 1024 * 1024, data: tiny,
      clientId: 'c1', sessionId: 's1',
    });

    const quotaErrors = sentMessages.filter(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ERROR && m.payload.code === 'QUOTA_EXCEEDED',
    );
    expect(quotaErrors).toHaveLength(1);
    expect(quotaErrors[0].payload.uploadId).toBe('uid-gcap-0');

    // NOTE: the 5 files are stuck at 100 MB each (per-file cap prevents chunk 1).
    // They remain buffered until their 5-min timeout. This is the last test in
    // the describe block, so no subsequent test depends on buffer state.
  });
});
