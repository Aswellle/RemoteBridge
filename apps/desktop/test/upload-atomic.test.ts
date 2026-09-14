import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { WSMessageType, encodeUploadChunkFrame } from '@remotebridge/shared';

// Per-test state
var sentMessages: any[] = [];
var jsonHandlers = new Map<string, (payload: any) => Promise<void> | void>();
var binaryHandlers = Array<(data: Buffer) => Promise<void> | void>();
var uploadSaveDir = '';

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
    images: path.join(uploadSaveDir, 'images'),
    videos: path.join(uploadSaveDir, 'videos'),
    documents: uploadSaveDir,
    archives: path.join(uploadSaveDir, 'archives'),
    markdown: path.join(uploadSaveDir, 'markdown'),
  }),
}));

import { setupMessageHandlers } from '../src/main/ws-client/handlers';

async function startAndFinalizeUpload(
  uploadId: string,
  fileName: string,
  content: Buffer,
) {
  const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);
  await startHandler!({
    uploadId,
    fileName,
    mimeType: 'application/octet-stream',
    category: 'documents',
    totalSize: content.length,
    clientId: 'client-1',
    sessionId: 'session-1',
  });

  const frame = encodeUploadChunkFrame({ transferId: uploadId, seq: 0, eof: true }, content);
  for (const handler of binaryHandlers) {
    await handler(frame);
  }
}

beforeEach(() => {
  uploadSaveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-atomic-test-'));
  sentMessages = [];
  jsonHandlers = new Map();
  binaryHandlers = [];
  setupMessageHandlers(null);
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const tmpDir = path.join(os.tmpdir(), 'remotebridge', 'uploads');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (uploadSaveDir && fs.existsSync(uploadSaveDir)) {
        fs.rmSync(uploadSaveDir, { recursive: true, force: true });
      }
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
});

describe('P1-03: Upload Atomic Commit', () => {
  it('assigns unique filenames for concurrent same-name uploads (O_EXCL race-safe)', async () => {
    const CONCURRENT = 10;
    const fileName = 'report.pdf';
    const promises: Promise<void>[] = [];

    for (let i = 0; i < CONCURRENT; i++) {
      const content = Buffer.from(`content-${i}`);
      promises.push(startAndFinalizeUpload(`uid-atomic-${i}`, fileName, content));
    }

    await Promise.all(promises);

    const acks = sentMessages.filter((m) => m.type === WSMessageType.RESP_UPLOAD_ACK);
    expect(acks).toHaveLength(CONCURRENT);

    const savedPaths = acks.map((a) => a.payload.savedPath);
    expect(new Set(savedPaths).size).toBe(CONCURRENT);

    const baseNames = new Set(savedPaths.map((p) => path.basename(p)));
    expect(baseNames.has('report.pdf')).toBe(true);
    for (let i = 1; i < CONCURRENT; i++) {
      expect(baseNames.has(`report (${i}).pdf`)).toBe(true);
    }

    for (let i = 0; i < CONCURRENT; i++) {
      const ack = acks.find((a) => a.payload.uploadId === `uid-atomic-${i}`);
      expect(fs.existsSync(ack.payload.savedPath)).toBe(true);
      const data = fs.readFileSync(ack.payload.savedPath);
      expect(data.toString()).toBe(`content-${i}`);
    }
  });

  it('atomic rename: no partial file visible on write failure', async () => {
    const uploadId = 'uid-atomic-fail';
    const fileName = 'fail-test.bin';
    const startHandler = jsonHandlers.get(WSMessageType.UPLOAD_START);

    await startHandler!({
      uploadId,
      fileName,
      mimeType: 'application/octet-stream',
      category: 'documents',
      totalSize: 100,
      clientId: 'client-1',
      sessionId: 'session-1',
    });

    const hugeChunk = Buffer.alloc(100 * 1024 * 1024 + 1, 0x61);
    const frame = encodeUploadChunkFrame({ transferId: uploadId, seq: 0, eof: true }, hugeChunk);
    for (const handler of binaryHandlers) {
      await handler(frame);
    }

    const errors = sentMessages.filter(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ERROR && m.payload.uploadId === uploadId,
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);

    const targetPath = path.join(uploadSaveDir, fileName);
    expect(fs.existsSync(targetPath)).toBe(false);
  });
});
