import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { WSMessageType } from '@remotebridge/shared';

// `var` (not let/const): vi.mock factories are hoisted above all imports,
// so these bindings must exist without TDZ when the factory closures execute.
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

beforeAll(() => {
  testUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-handlers-test-'));
  setupMessageHandlers(null as any);
});

afterAll(() => {
  if (testUploadDir) fs.rmSync(testUploadDir, { recursive: true, force: true });
});

beforeEach(() => {
  sentMessages = [];
});

describe('CMD_UPLOAD_FILE_CHUNK — 安全校验与正确性 (TST-H2)', () => {
  it('拒绝未知 category，返回 INVALID_CATEGORY', async () => {
    await emitChunk({
      uploadId: 'uid-bad-cat',
      chunkIndex: 0, totalChunks: 1,
      fileName: 'test.txt', mimeType: 'text/plain',
      category: 'illegal_category',
      totalSize: 10, data: Buffer.from('hello').toString('base64'),
      clientId: 'c1', sessionId: 's1',
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].type).toBe(WSMessageType.RESP_UPLOAD_ERROR);
    expect(sentMessages[0].payload.code).toBe('INVALID_CATEGORY');
  });

  it('path.basename 剥除 fileName 中的目录遍历成分', async () => {
    await emitChunk({
      uploadId: 'uid-traversal',
      chunkIndex: 0, totalChunks: 1,
      fileName: '../../../etc/passwd',
      mimeType: 'text/plain', category: 'documents',
      totalSize: 7, data: Buffer.from('content').toString('base64'),
      clientId: 'c1', sessionId: 's1',
    });

    const ack = sentMessages.find(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ACK && m.payload.uploadId === 'uid-traversal',
    );
    expect(ack).toBeDefined();

    // savedPath 必须在 documents 子目录内，不含 ..
    const savedPath: string = ack.payload.savedPath;
    expect(savedPath).not.toContain('..');
    expect(savedPath.startsWith(path.resolve(testUploadDir, 'documents'))).toBe(true);

    // 实际写入的文件名应为 path.basename('../../../etc/passwd') = 'passwd'
    expect(path.basename(savedPath)).toBe('passwd');
  });

  it('多分块上传正确组装内容，fileSize 等于实际字节数', async () => {
    const uid = 'uid-multichunk';
    const chunk0 = Buffer.from('hello ');
    const chunk1 = Buffer.from('world');

    await emitChunk({
      uploadId: uid, chunkIndex: 0, totalChunks: 2,
      fileName: 'multi.txt', mimeType: 'text/plain', category: 'documents',
      totalSize: 11, data: chunk0.toString('base64'),
      clientId: 'c1', sessionId: 's1',
    });
    await emitChunk({
      uploadId: uid, chunkIndex: 1, totalChunks: 2,
      fileName: 'multi.txt', mimeType: 'text/plain', category: 'documents',
      totalSize: 11, data: chunk1.toString('base64'),
      clientId: 'c1', sessionId: 's1',
    });

    const ack = sentMessages.find(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ACK && m.payload.uploadId === uid,
    );
    expect(ack).toBeDefined();
    expect(ack.payload.fileSize).toBe(11); // 'hello world'.length
  });

  it('SEC-H1: 三个并发上传各声称 200MB 均被接受（totalBufferedBytes 不预计入 totalSize）', async () => {
    // 攻击场景（旧代码行为）: admission 时 totalBufferedBytes += totalSize（200MB）
    //   → 第 3 个: 400MB + 200MB = 600MB > 500MB → QUOTA_EXCEEDED（误杀合法上传）
    // 修复后（SEC-H1）: totalBufferedBytes 只在分块到达时按实际字节累加
    //   → admission 时 totalBufferedBytes ≈ 0，三个 200MB 声明的上传都通过
    const MB = 1024 * 1024;
    const tinyData = Buffer.from('x').toString('base64'); // 实际 1 字节

    for (let i = 0; i < 3; i++) {
      await emitChunk({
        uploadId: `uid-quota-${i}`,
        chunkIndex: 0, totalChunks: 1,
        fileName: `q${i}.txt`, mimeType: 'text/plain', category: 'documents',
        totalSize: 200 * MB, // 声称 200MB，三个累计 600MB > 500MB 上限
        data: tinyData,
        clientId: 'c1', sessionId: 's1',
      });
    }

    const quotaErrors = sentMessages.filter(
      (m) => m.type === WSMessageType.RESP_UPLOAD_ERROR && m.payload.code === 'QUOTA_EXCEEDED',
    );
    expect(quotaErrors).toHaveLength(0);

    const acks = sentMessages.filter((m) => m.type === WSMessageType.RESP_UPLOAD_ACK);
    expect(acks).toHaveLength(3);
  });
});
