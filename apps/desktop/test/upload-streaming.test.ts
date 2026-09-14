import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  WSMessageType,
  encodeUploadChunkFrame,
} from '@remotebridge/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Captured state from mocked client
var jsonMessages: any[] = [];
var binaryFrames: Buffer[] = [];
var jsonHandlers = new Map<string, (payload: any) => Promise<void> | void>();
var binaryHandlers = Array<(data: Buffer) => Promise<void> | void>();

vi.mock('../src/main/ws-client/client', () => ({
  getRelayClient: () => ({
    on: (type: string, handler: (payload: any) => Promise<void> | void) => {
      jsonHandlers.set(type, handler);
    },
    onBinary: (handler: (data: Buffer) => Promise<void> | void) => {
      binaryHandlers.push(handler);
    },
    send: (message: any) => {
      jsonMessages.push(message);
      return true;
    },
    sendRaw: (buffer: Buffer) => {
      binaryFrames.push(buffer);
      return true;
    },
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
  config: {
    getUploadPaths: () => null,
  },
  getDefaultUploadPaths: async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-upload-test-'));
    return {
      images: path.join(base, 'images'),
      videos: path.join(base, 'videos'),
      documents: path.join(base, 'documents'),
      archives: path.join(base, 'archives'),
      markdown: path.join(base, 'markdown'),
    };
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
  Notification: {
    isSupported: () => false,
  },
}));

import { setupMessageHandlers, resetUploadTransfersForTests } from '../src/main/ws-client/handlers';

const TEST_FILE_SIZE = 600 * 1024; // 600KB — spans multiple 256KB chunks

describe('V2 Upload Binary Streaming (P1-01)', () => {
  beforeAll(() => {
    setupMessageHandlers(null);
  });

  beforeEach(() => {
    jsonMessages = [];
    binaryFrames = [];
    jsonHandlers = new Map();
    binaryHandlers = [];
    resetUploadTransfersForTests();
    // Re-register handlers after reset
    setupMessageHandlers(null);
  });

  afterAll(async () => {
    // Wait for write stream handles to close before cleanup (Windows file locking)
    await new Promise((r) => setTimeout(r, 200));
    // Clean up any temp files created during tests
    const tmpDir = path.join(os.tmpdir(), 'remotebridge', 'uploads');
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  function makeTestData(): Buffer {
    const data = Buffer.alloc(TEST_FILE_SIZE);
    for (let i = 0; i < TEST_FILE_SIZE; i++) data[i] = i % 256;
    return data;
  }

  it('streams upload chunks to temp file and finalizes with atomic rename', async () => {
    const uploadId = 'upload-test-1';
    const fileName = 'test-document.pdf';
    const testData = makeTestData();

    // 1. Send UPLOAD_START
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);
    expect(startHandler).toBeDefined();

    await startHandler!({
      uploadId,
      fileName,
      mimeType: 'application/pdf',
      category: 'documents',
      totalSize: testData.length,
      clientId: 'client-1',
      sessionId: 'session-1',
    });

    // Verify no ACK yet
    expect(jsonMessages.filter((m) => m.type === WSMessageType.RESP_UPLOAD_ACK)).toHaveLength(0);

    // 2. Stream binary chunks
    const CHUNK_SIZE = 256 * 1024;
    let offset = 0;
    let seq = 0;
    const totalChunks = Math.ceil(testData.length / CHUNK_SIZE);

    while (offset < testData.length) {
      const end = Math.min(offset + CHUNK_SIZE, testData.length);
      const chunk = testData.subarray(offset, end);
      const isEof = end >= testData.length;
      const frame = encodeUploadChunkFrame({ transferId: uploadId, seq, eof: isEof }, chunk);

      // Dispatch to all binary handlers
      for (const handler of binaryHandlers) {
        await handler(frame);
      }

      offset = end;
      seq++;
    }

    expect(seq).toBe(totalChunks);

    // 3. Verify RESP_UPLOAD_ACK was sent
    const acks = jsonMessages.filter((m) => m.type === WSMessageType.RESP_UPLOAD_ACK);
    expect(acks).toHaveLength(1);
    expect(acks[0].payload.uploadId).toBe(uploadId);
    expect(acks[0].payload.fileName).toBe(fileName);
    expect(acks[0].payload.fileSize).toBe(TEST_FILE_SIZE);

    // 4. Verify the saved file content matches
    const savedPath = acks[0].payload.savedPath;
    expect(fs.existsSync(savedPath)).toBe(true);
    const savedData = fs.readFileSync(savedPath);
    expect(savedData.equals(testData)).toBe(true);
  });

  it('rejects out-of-order chunks (sequence validation)', async () => {
    const uploadId = 'upload-test-2';
    const fileName = 'seq-test.txt';
    const testData = Buffer.from('Hello World test data for sequence validation');

    // Start upload
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);
    await startHandler!({
      uploadId,
      fileName,
      mimeType: 'text/plain',
      category: 'documents',
      totalSize: testData.length,
      clientId: 'client-1',
      sessionId: 'session-1',
    });

    // Send chunk with wrong seq (skip seq 0, send seq 1)
    const frame = encodeUploadChunkFrame({ transferId: uploadId, seq: 1, eof: false }, testData);
    for (const handler of binaryHandlers) {
      await handler(frame);
    }

    // No ACK should be sent — chunk was rejected
    expect(jsonMessages.filter((m) => m.type === WSMessageType.RESP_UPLOAD_ACK)).toHaveLength(0);
  });

  it('cancels upload on UPLOAD_CANCEL', async () => {
    const uploadId = 'upload-test-3';
    const fileName = 'cancel-test.bin';
    const testData = Buffer.alloc(1000, 0xab);

    // Start upload
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);
    await startHandler!({
      uploadId,
      fileName,
      mimeType: 'application/octet-stream',
      category: 'documents',
      totalSize: testData.length,
      clientId: 'client-1',
      sessionId: 'session-1',
    });

    // Send one chunk
    const frame = encodeUploadChunkFrame({ transferId: uploadId, seq: 0, eof: false }, testData);
    for (const handler of binaryHandlers) {
      await handler(frame);
    }

    // Cancel
    const cancelHandler = jsonHandlers.get(WSMessageType.UPLOAD_CANCEL);
    expect(cancelHandler).toBeDefined();
    await cancelHandler!({ uploadId, reason: 'user_cancelled' });

    // No ACK should be sent
    expect(jsonMessages.filter((m) => m.type === WSMessageType.RESP_UPLOAD_ACK)).toHaveLength(0);
  });

  it('rejects invalid category', async () => {
    const uploadId = 'upload-test-4';
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);
    await startHandler!({
      uploadId,
      fileName: 'bad-cat.txt',
      mimeType: 'text/plain',
      category: 'invalid_category',
      totalSize: 100,
      clientId: 'client-1',
      sessionId: 'session-1',
    });

    const errors = jsonMessages.filter((m) => m.type === WSMessageType.RESP_UPLOAD_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0].payload.code).toBe('INVALID_CATEGORY');
  });

  it('enforces concurrent upload quota', async () => {
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);
    const cancelHandler = jsonHandlers.get(WSMessageType.UPLOAD_CANCEL);

    // Fill all 5 slots (MAX_CONCURRENT_UPLOADS)
    for (let i = 0; i < 5; i++) {
      await startHandler!({
        uploadId: `upload-quota-${i}`,
        fileName: `file-${i}.txt`,
        mimeType: 'text/plain',
        category: 'documents',
        totalSize: 100,
        clientId: 'client-1',
        sessionId: 'session-1',
      });
    }

    // 6th upload should be rejected
    await startHandler!({
      uploadId: 'upload-quota-6',
      fileName: 'file-6.txt',
      mimeType: 'text/plain',
      category: 'documents',
      totalSize: 100,
      clientId: 'client-1',
      sessionId: 'session-1',
    });

    const quotaErrors = jsonMessages.filter(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ERROR && m.payload.code === 'QUOTA_EXCEEDED',
    );
    expect(quotaErrors.length).toBeGreaterThanOrEqual(1);

    // Clean up dangling transfers to avoid ENOENT on afterAll cleanup
    for (let i = 0; i < 5; i++) {
      await cancelHandler!({ uploadId: `upload-quota-${i}`, reason: 'test_end' });
    }
  });

  it('closes upload stream before atomic rename (Windows race regression)', async () => {
    const uploadId = 'uid-windows-close-race';
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);
    const cancelHandler = jsonHandlers.get(WSMessageType.UPLOAD_CANCEL);

    // Use 8 MB — large enough to exercise write stream buffering
    const FILE_SIZE = 8 * 1024 * 1024;

    await startHandler!({
      uploadId,
      fileName: 'win-race.bin',
      mimeType: 'application/octet-stream',
      category: 'documents',
      totalSize: FILE_SIZE,
      clientId: 'client-1',
      sessionId: 'session-1',
    });

    // Stream in 256 KB chunks
    const CHUNK = 256 * 1024;
    let seq = 0;
    let offset = 0;
    while (offset < FILE_SIZE) {
      const end = Math.min(offset + CHUNK, FILE_SIZE);
      const chunk = Buffer.alloc(end - offset, 0xAB);
      const isEof = end >= FILE_SIZE;
      const frame = encodeUploadChunkFrame({ transferId: uploadId, seq, eof: isEof }, chunk);
      for (const handler of binaryHandlers) {
        // eslint-disable-next-line no-await-in-loop
        await handler(frame);
      }
      offset = end;
      seq++;
    }

    const acks = jsonMessages.filter(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ACK && m.payload.uploadId === uploadId,
    );
    expect(acks).toHaveLength(1);

    // Verify the file was actually saved with correct size (proves stream was closed before rename)
    const savedPath = acks[0].payload.savedPath;
    expect(fs.existsSync(savedPath)).toBe(true);
    const stat = fs.statSync(savedPath);
    expect(stat.size).toBe(FILE_SIZE);

    // Clean up
    fs.unlinkSync(savedPath);
    await cancelHandler!({ uploadId, reason: 'test_end' });
  });
});
