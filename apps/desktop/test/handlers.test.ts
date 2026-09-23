import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { WSMessageType, encodeUploadChunkFrame } from '@remotebridge/shared';

// Captured state from mocked client
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

vi.mock('../src/main/db/client', () => ({
  default: {
    insertMessage: vi.fn(),
    upsertConnectedClient: vi.fn(),
  },
}));

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

async function dispatchBinary(frame: Buffer) {
  for (const handler of binaryHandlers) {
    await handler(frame);
  }
}

beforeAll(() => {
  testUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-handlers-test-'));
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

describe('V2 Upload Binary Streaming — security & correctness (TST-H2)', () => {
  it('rejects invalid category, returns INVALID_CATEGORY', async () => {
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);
    await startHandler!({
      uploadId: 'uid-bad-cat',
      fileName: 'test.txt',
      mimeType: 'text/plain',
      category: 'illegal_category',
      totalSize: 10,
      clientId: 'c1',
      sessionId: 's1',
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].type).toBe(WSMessageType.RESP_UPLOAD_ERROR);
    expect(sentMessages[0].payload.code).toBe('INVALID_CATEGORY');
  });

  it('strips directory traversal from fileName via path.basename', async () => {
    const uploadId = 'uid-traversal';
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);

    await startHandler!({
      uploadId,
      fileName: '../../../etc/passwd',
      mimeType: 'text/plain',
      category: 'documents',
      totalSize: 7,
      clientId: 'c1',
      sessionId: 's1',
    });

    // Send EOF chunk
    await dispatchBinary(encodeUploadChunkFrame({ transferId: uploadId, seq: 0, eof: true }, Buffer.from('content')));

    const ack = sentMessages.find(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ACK && m.payload.uploadId === uploadId,
    );
    expect(ack).toBeDefined();

    // savedPath must be within documents subdirectory, no '..' components
    const savedPath: string = ack.payload.savedPath;
    expect(savedPath).not.toContain('..');
    expect(savedPath.startsWith(path.resolve(testUploadDir))).toBe(true);

    // Actual saved file name should be path.basename('../../../etc/passwd') = 'passwd'
    expect(path.basename(savedPath)).toBe('passwd');
  });

  it('streams multi-chunk upload and reports exact byte count', async () => {
    const uid = 'uid-multichunk';
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);

    await startHandler!({
      uploadId: uid,
      fileName: 'multi.bin',
      mimeType: 'application/octet-stream',
      category: 'documents',
      totalSize: 11,
      clientId: 'c1',
      sessionId: 's1',
    });

    const chunk0 = Buffer.from('hello ');
    const chunk1 = Buffer.from('world');

    await dispatchBinary(encodeUploadChunkFrame({ transferId: uid, seq: 0, eof: false }, chunk0));
    await dispatchBinary(encodeUploadChunkFrame({ transferId: uid, seq: 1, eof: true }, chunk1));

    const ack = sentMessages.find(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ACK && m.payload.uploadId === uid,
    );
    expect(ack).toBeDefined();
    expect(ack.payload.fileSize).toBe(11); // 'hello world'.length
  });

  it('rejects out-of-order chunks (sequence validation)', async () => {
    const uploadId = 'uid-oob';
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);

    await startHandler!({
      uploadId,
      fileName: 'seq.txt',
      mimeType: 'text/plain',
      category: 'documents',
      totalSize: 100,
      clientId: 'c1',
      sessionId: 's1',
    });

    // Send chunk with wrong seq (skip seq 0)
    await dispatchBinary(encodeUploadChunkFrame({ transferId: uploadId, seq: 1, eof: false }, Buffer.from('data')));

    // No ACK — chunk was rejected
    const acks = sentMessages.filter((m) => m.type === WSMessageType.RESP_UPLOAD_ACK);
    expect(acks).toHaveLength(0);
  });

  it('enforces per-file size cap on actual bytes (SEC-H1)', async () => {
    const uploadId = 'uid-overflow';
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);

    await startHandler!({
      uploadId,
      fileName: 'overflow.bin',
      mimeType: 'application/octet-stream',
      category: 'documents',
      totalSize: 1, // attacker lies: claim tiny
      clientId: 'c1',
      sessionId: 's1',
    });

    // Stream 100MB+1 in 64MB chunks
    const chunk1 = Buffer.alloc(64 * 1024 * 1024, 0x61);
    const chunk2 = Buffer.alloc((100 * 1024 * 1024 + 1) - 64 * 1024 * 1024, 0x62);

    await dispatchBinary(encodeUploadChunkFrame({ transferId: uploadId, seq: 0, eof: false }, chunk1));
    await dispatchBinary(encodeUploadChunkFrame({ transferId: uploadId, seq: 1, eof: true }, chunk2));

    const quotaErrors = sentMessages.filter(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ERROR && m.payload.code === 'QUOTA_EXCEEDED',
    );
    expect(quotaErrors.length).toBeGreaterThanOrEqual(1);

    const acks = sentMessages.filter((m) => m.type === WSMessageType.RESP_UPLOAD_ACK);
    expect(acks).toHaveLength(0);
  });
});
