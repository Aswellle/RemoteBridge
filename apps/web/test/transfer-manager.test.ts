import { describe, it, expect, beforeEach } from 'vitest';
import { webTransferManager } from '../src/lib/transfer/manager';
import { TransferState } from '@remotebridge/shared';

describe('WebTransferManager — download/upload/preview tri-state', () => {
  let manager = webTransferManager;

  it('supports download direction', () => {
    const id = manager.begin({
      transferId: 'dl-1',
      direction: 'download',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      totalBytes: 5000000,
    });

    const record = manager.get(id);
    expect(record).toBeDefined();
    expect(record!.direction).toBe('download');
    expect(record!.state).toBe(TransferState.PENDING);

    manager.setDownloadUrl(id, 'https://relay.example.com/proxy/123');
    expect(manager.getWebRecord(id)!.downloadUrl).toBe('https://relay.example.com/proxy/123');

    manager.markStreaming(id);
    manager.recordBytes(id, 2500000);
    manager.recordBytes(id, 2500000);
    manager.complete(id);

    expect(manager.get(id)!.state).toBe(TransferState.COMPLETED);
    expect(manager.get(id)!.transferredBytes).toBe(5000000);
  });

  it('supports upload direction', () => {
    const id = manager.begin({
      transferId: 'ul-1',
      direction: 'upload',
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      totalBytes: 2000000,
      category: 'images',
    });

    const record = manager.get(id);
    expect(record!.direction).toBe('upload');
    expect(record!.category).toBe('images');

    manager.markStreaming(id);
    manager.recordBytes(id, 2000000);
    manager.complete(id);

    expect(manager.get(id)!.state).toBe(TransferState.COMPLETED);
  });

  it('supports preview direction', () => {
    const id = manager.begin({
      transferId: 'pv-1',
      direction: 'preview',
      fileName: 'doc.md',
      mimeType: 'text/markdown',
      totalBytes: 0,
    });

    const record = manager.get(id);
    expect(record!.direction).toBe('preview');

    manager.setPreviewUrl(id, 'blob:http://localhost/abc-123');
    expect(manager.getWebRecord(id)!.previewUrl).toBe('blob:http://localhost/abc-123');

    manager.complete(id);
    expect(manager.get(id)!.state).toBe(TransferState.COMPLETED);
  });

  it('tracks all three directions simultaneously', () => {
    const dlId = manager.begin({ transferId: 'dl', direction: 'download', fileName: 'a.zip', mimeType: 'application/zip', totalBytes: 1000 });
    const ulId = manager.begin({ transferId: 'ul', direction: 'upload', fileName: 'b.png', mimeType: 'image/png', totalBytes: 500 });
    const pvId = manager.begin({ transferId: 'pv', direction: 'preview', fileName: 'c.txt', mimeType: 'text/plain', totalBytes: 0 });

    expect(manager.getActive()).toHaveLength(3);

    manager.complete(dlId);
    manager.fail(ulId, 'network error');
    manager.cancel(pvId, 'user_cancel');

    expect(manager.getActive()).toHaveLength(0);
    expect(manager.get(dlId)!.state).toBe(TransferState.COMPLETED);
    expect(manager.get(ulId)!.state).toBe(TransferState.FAILED);
    expect(manager.get(pvId)!.state).toBe(TransferState.CANCELLED);
  });

  it('aborts fetch on cancel', () => {
    const id = manager.begin({
      transferId: 'abort-test',
      direction: 'download',
      fileName: 'big.bin',
      mimeType: 'application/octet-stream',
      totalBytes: 1000000,
    });

    // Mock AbortController for happy-dom environment
    const abortSpy = vi.fn();
    const mockController = { abort: abortSpy, signal: { aborted: false } };
    manager.setAbortController(id, mockController as any);

    manager.cancel(id, 'user_cancel');
    expect(abortSpy).toHaveBeenCalled();
    expect(manager.get(id)!.state).toBe(TransferState.CANCELLED);
  });

});
