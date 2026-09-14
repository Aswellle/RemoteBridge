import { describe, it, expect, beforeEach } from 'vitest';
import { BaseTransferManager } from '../src/transfer/manager';
import { TransferState } from '../src/transfer/model';

describe('BaseTransferManager', () => {
  let manager: BaseTransferManager;

  beforeEach(() => {
    manager = new BaseTransferManager({ idleTimeoutMs: 5000, maxConcurrent: 5 });
  });

  it('begins a transfer in PENDING state', () => {
    const id = manager.begin({
      transferId: 't-1',
      direction: 'download',
      fileName: 'test.pdf',
      mimeType: 'application/pdf',
      totalBytes: 1000,
    });

    expect(id).toBe('t-1');
    const record = manager.get('t-1');
    expect(record).toBeDefined();
    expect(record!.state).toBe(TransferState.PENDING);
    expect(record!.transferredBytes).toBe(0);
  });

  it('tracks progress and transitions to STREAMING', () => {
    manager.begin({
      transferId: 't-2',
      direction: 'upload',
      fileName: 'doc.txt',
      mimeType: 'text/plain',
      totalBytes: 1000,
    });

    manager.markStreaming('t-2');
    expect(manager.get('t-2')!.state).toBe(TransferState.STREAMING);

    manager.recordBytes('t-2', 500);
    expect(manager.get('t-2')!.transferredBytes).toBe(500);

    manager.recordBytes('t-2', 500);
    expect(manager.get('t-2')!.transferredBytes).toBe(1000);
  });

  it('completes a transfer', () => {
    manager.begin({
      transferId: 't-3',
      direction: 'download',
      fileName: 'a.bin',
      mimeType: 'application/octet-stream',
      totalBytes: 100,
    });

    manager.complete('t-3');
    expect(manager.get('t-3')!.state).toBe(TransferState.COMPLETED);
    expect(manager.getActive()).toHaveLength(0);
  });

  it('fails a transfer with error details', () => {
    manager.begin({
      transferId: 't-4',
      direction: 'preview',
      fileName: 'img.png',
      mimeType: 'image/png',
      totalBytes: 0,
    });

    manager.fail('t-4', 'Host read error', 'READ_ERROR');
    const record = manager.get('t-4');
    expect(record!.state).toBe(TransferState.FAILED);
    expect(record!.errorMessage).toBe('Host read error');
    expect(record!.errorCode).toBe('READ_ERROR');
  });

  it('cancels a transfer idempotently', () => {
    manager.begin({
      transferId: 't-5',
      direction: 'download',
      fileName: 'b.zip',
      mimeType: 'application/zip',
      totalBytes: 5000,
      sessionId: 'sess-1',
    });

    expect(manager.cancel('t-5', 'user_cancel')).toBe(true);
    expect(manager.get('t-5')!.state).toBe(TransferState.CANCELLED);
    expect(manager.get('t-5')!.cancelReason).toBe('user_cancel');

    // Second cancel is a no-op
    expect(manager.cancel('t-5', 'user_cancel')).toBe(false);
  });

  it('cancels all transfers for a session', () => {
    for (let i = 0; i < 3; i++) {
      manager.begin({
        transferId: `t-sess-${i}`,
        direction: 'download',
        fileName: `f${i}.txt`,
        mimeType: 'text/plain',
        totalBytes: 100,
        sessionId: 'sess-2',
      });
    }
    // Add one with a different session
    manager.begin({
      transferId: 't-other',
      direction: 'download',
      fileName: 'other.txt',
      mimeType: 'text/plain',
      totalBytes: 100,
      sessionId: 'sess-other',
    });

    const cancelled = manager.cancelSession('sess-2', 'session_revoked');
    expect(cancelled).toBe(3);

    for (let i = 0; i < 3; i++) {
      expect(manager.get(`t-sess-${i}`)!.state).toBe(TransferState.CANCELLED);
    }
    // Other session untouched
    expect(manager.get('t-other')!.state).toBe(TransferState.PENDING);
  });

  it('filters active vs terminal transfers', () => {
    manager.begin({ transferId: 'a', direction: 'download', fileName: 'a.txt', mimeType: 'text/plain', totalBytes: 100 });
    manager.begin({ transferId: 'b', direction: 'download', fileName: 'b.txt', mimeType: 'text/plain', totalBytes: 100 });
    manager.begin({ transferId: 'c', direction: 'download', fileName: 'c.txt', mimeType: 'text/plain', totalBytes: 100 });

    manager.complete('a');
    manager.fail('b', 'err');
    // c stays PENDING

    expect(manager.getActive()).toHaveLength(1);
    expect(manager.getActive()[0].transferId).toBe('c');
    expect(manager.activeCount()).toBe(1);
  });

  it('emits events to subscribers', () => {
    const events: string[] = [];
    manager.on((e) => events.push(e.type));

    manager.begin({ transferId: 'ev-1', direction: 'upload', fileName: 'e.txt', mimeType: 'text/plain', totalBytes: 100 });
    manager.markStreaming('ev-1');
    manager.recordBytes('ev-1', 50);
    manager.complete('ev-1');

    expect(events).toContain('state');
    expect(events).toContain('progress');
    expect(events).toContain('complete');
  });
});
