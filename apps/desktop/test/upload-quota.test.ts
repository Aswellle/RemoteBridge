import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { WSMessageType, encodeUploadChunkFrame } from '@remotebridge/shared';

// Isolated module state for V2 upload quota tests
var sentMessages: any[] = [];
var jsonHandlers = new Map<string, (payload: any) => Promise<void> | void>();
var binaryHandlers = Array<(data: Buffer) => Promise<void> | void>();
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
      jsonHandlers.set(type, handler);
    },
    onBinary: (handler: (data: Buffer) => Promise<void> | void) => {
      binaryHandlers.push(handler);
    },
    send: (msg: any) => { sentMessages.push(msg); return true; },
    isConnected: () => true,
  }),
}));

vi.mock('../src/main/db/client', () => {
  const db = {
    insertMessage: vi.fn(() => {}),
    upsertConnectedClient: vi.fn(() => {}),
  };
  return { db, default: db };
});

vi.mock('../src/main/config/store', () => ({
  config: { getUploadPaths: vi.fn(() => null) },
  getDefaultUploadPaths: async () => ({
    images: path.join(testUploadDir, 'images'),
    videos: path.join(testUploadDir, 'videos'),
    documents: testUploadDir,
    archives: path.join(testUploadDir, 'archives'),
    markdown: path.join(testUploadDir, 'markdown'),
  }),
}));

import { setupMessageHandlers, resetUploadTransfersForTests } from '../src/main/ws-client/handlers';

// 100 MB + 1 byte — one byte over the per-file cap.
const OVER_FILE_CAP = 100 * 1024 * 1024 + 1;

async function dispatchBinary(frame: Buffer) {
  for (const handler of binaryHandlers) {
    await handler(frame);
  }
}

beforeAll(() => {
  testUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-upload-quota-'));
  setupMessageHandlers(null);
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
  if (testUploadDir) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(testUploadDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
});

beforeEach(() => {
  sentMessages = [];
  jsonHandlers = new Map();
  binaryHandlers = [];
  resetUploadTransfersForTests();
  setupMessageHandlers(null);
});

describe('V2 Upload Quota (PH1 / SEC-H1)', () => {
  it('rejects upload when accumulated bytes exceed the 100 MB per-file cap', async () => {
    const uploadId = 'uid-over-cap';
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);

    await startHandler!({
      uploadId,
      fileName: 'huge.bin',
      mimeType: 'application/octet-stream',
      category: 'documents',
      totalSize: 1, // attacker lies: claim it's tiny
      clientId: 'c1',
      sessionId: 's1',
    });

    // Stream chunks that total > 100 MB
    const chunkSize = 64 * 1024 * 1024; // 64 MB each
    const chunk1 = Buffer.alloc(chunkSize, 0x61);
    const chunk2 = Buffer.alloc(OVER_FILE_CAP - chunkSize + 1, 0x62);

    await dispatchBinary(encodeUploadChunkFrame({ transferId: uploadId, seq: 0, eof: false }, chunk1));
    await dispatchBinary(encodeUploadChunkFrame({ transferId: uploadId, seq: 1, eof: true }, chunk2));

    const quotaErrors = sentMessages.filter(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ERROR && m.payload.code === 'QUOTA_EXCEEDED',
    );
    expect(quotaErrors.length).toBeGreaterThanOrEqual(1);

    // No ACK must be emitted — the file was never persisted
    const acks = sentMessages.filter((m) => m.type === WSMessageType.RESP_UPLOAD_ACK);
    expect(acks).toHaveLength(0);
  });

  it('accepts upload at exactly the 100 MB boundary', async () => {
    const uploadId = 'uid-exact-cap';
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);

    const exactSize = 100 * 1024 * 1024;
    await startHandler!({
      uploadId,
      fileName: 'exact.bin',
      mimeType: 'application/octet-stream',
      category: 'documents',
      totalSize: exactSize,
      clientId: 'c1',
      sessionId: 's1',
    });

    // Send in 256KB chunks
    const CHUNK = 256 * 1024;
    let seq = 0;
    let offset = 0;
    while (offset < exactSize) {
      const end = Math.min(offset + CHUNK, exactSize);
      const chunk = Buffer.alloc(end - offset, 0x63);
      const isEof = end >= exactSize;
      await dispatchBinary(encodeUploadChunkFrame({ transferId: uploadId, seq, eof: isEof }, chunk));
      offset = end;
      seq++;
    }

    const acks = sentMessages.filter(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ACK && m.payload.uploadId === uploadId,
    );
    expect(acks).toHaveLength(1);
    expect(acks[0].payload.fileSize).toBe(exactSize);
  });

  it('rejects UPLOAD_START when totalSize is exactly 100 MB + 1 byte', async () => {
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);

    const overSize = 100 * 1024 * 1024 + 1;
    await startHandler!({
      uploadId: 'uid-one-byte-over-cap',
      fileName: 'over.bin',
      mimeType: 'application/octet-stream',
      category: 'documents',
      totalSize: overSize,
      clientId: 'c1',
      sessionId: 's1',
    });

    const errors = sentMessages.filter(
      (m) =>
        m.type === WSMessageType.RESP_UPLOAD_ERROR &&
        m.payload.uploadId === 'uid-one-byte-over-cap' &&
        m.payload.code === 'INVALID_UPLOAD_SIZE',
    );
    expect(errors).toHaveLength(1);
  });

  it('rejects UPLOAD_START when totalSize exceeds MAX_FILE_BYTES but chunk stream stays within cap', async () => {
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);
    // totalSize over cap → rejected immediately at UPLOAD_START
    const overSize = 100 * 1024 * 1024 + 1;
    await startHandler!({
      uploadId: 'uid-total-over',
      fileName: 'over.bin',
      mimeType: 'application/octet-stream',
      category: 'documents',
      totalSize: overSize,
      clientId: 'c1',
      sessionId: 's1',
    });
    const startErrors = sentMessages.filter(
      (m) =>
        m.type === WSMessageType.RESP_UPLOAD_ERROR &&
        m.payload.uploadId === 'uid-total-over' &&
        m.payload.code === 'INVALID_UPLOAD_SIZE',
    );
    expect(startErrors).toHaveLength(1);
  });

  it('blocks the 6th concurrent upload once MAX_CONCURRENT_UPLOADS (5) is reached', async () => {
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);
    const cancelHandler = jsonHandlers.get(WSMessageType.UPLOAD_CANCEL);

    // Fill all 5 slots
    for (let i = 0; i < 5; i++) {
      await startHandler!({
        uploadId: `uid-concurrent-${i}`,
        fileName: `f${i}.txt`,
        mimeType: 'text/plain',
        category: 'documents',
        totalSize: 1000,
        clientId: 'c1',
        sessionId: 's1',
      });
    }

    // 6th should be rejected
    await startHandler!({
      uploadId: 'uid-concurrent-6',
      fileName: 'f6.txt',
      mimeType: 'text/plain',
      category: 'documents',
      totalSize: 1000,
      clientId: 'c1',
      sessionId: 's1',
    });

    const quotaErrors = sentMessages.filter(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ERROR && m.payload.code === 'QUOTA_EXCEEDED',
    );
    expect(quotaErrors.length).toBeGreaterThanOrEqual(1);

    // Clean up
    for (let i = 0; i < 5; i++) {
      await cancelHandler!({ uploadId: `uid-concurrent-${i}`, reason: 'test_end' });
    }
  });
});
