import { describe, it, expect } from 'vitest';
import { encodeFileChunkFrame, decodeFileChunkFrame } from '../src/file-tunnel-codec';

describe('encodeFileChunkFrame / decodeFileChunkFrame', () => {
  it('round-trips a first chunk (seq === 0) carrying file metadata', () => {
    const chunk = Buffer.from('hello world');
    const frame = encodeFileChunkFrame(
      {
        transferId: 'tr-123',
        seq: 0,
        eof: false,
        totalSize: 1024,
        rangeStart: 0,
        rangeEnd: 1023,
        contentType: 'text/plain',
        fileName: 'demo.txt',
      },
      chunk,
    );

    const decoded = decodeFileChunkFrame(frame);

    expect(decoded.transferId).toBe('tr-123');
    expect(decoded.seq).toBe(0);
    expect(decoded.eof).toBe(false);
    expect(decoded.totalSize).toBe(1024);
    expect(decoded.rangeStart).toBe(0);
    expect(decoded.rangeEnd).toBe(1023);
    expect(decoded.contentType).toBe('text/plain');
    expect(decoded.fileName).toBe('demo.txt');
    expect(decoded.data.equals(chunk)).toBe(true);
  });

  it('round-trips a non-first chunk without metadata', () => {
    const chunk = Buffer.from([1, 2, 3, 4, 5]);
    const frame = encodeFileChunkFrame(
      { transferId: 'tr-123', seq: 1, eof: false },
      chunk,
    );

    const decoded = decodeFileChunkFrame(frame);

    expect(decoded.transferId).toBe('tr-123');
    expect(decoded.seq).toBe(1);
    expect(decoded.eof).toBe(false);
    expect(decoded.totalSize).toBeUndefined();
    expect(decoded.rangeStart).toBeUndefined();
    expect(decoded.rangeEnd).toBeUndefined();
    expect(decoded.contentType).toBeUndefined();
    expect(decoded.fileName).toBeUndefined();
    expect(decoded.data.equals(chunk)).toBe(true);
  });

  it('round-trips the final (eof) chunk', () => {
    const chunk = Buffer.from('last bytes');
    const frame = encodeFileChunkFrame({ transferId: 'tr-456', seq: 7, eof: true }, chunk);

    const decoded = decodeFileChunkFrame(frame);

    expect(decoded.seq).toBe(7);
    expect(decoded.eof).toBe(true);
    expect(decoded.data.equals(chunk)).toBe(true);
  });

  it('handles totalSize/rangeStart/rangeEnd values beyond uint32 range', () => {
    // 实际文件大小远小于 2^53，但仍验证 uint64 (两个 uint32 半字) 编码对超过
    // 2^32 的值不产生溢出/截断
    const big = 5 * 1024 * 1024 * 1024; // 5 GiB > 2^32
    const chunk = Buffer.from('x');
    const frame = encodeFileChunkFrame(
      {
        transferId: 'tr-big',
        seq: 0,
        eof: false,
        totalSize: big,
        rangeStart: 0,
        rangeEnd: big - 1,
        contentType: 'application/octet-stream',
        fileName: 'huge.bin',
      },
      chunk,
    );

    const decoded = decodeFileChunkFrame(frame);

    expect(decoded.totalSize).toBe(big);
    expect(decoded.rangeStart).toBe(0);
    expect(decoded.rangeEnd).toBe(big - 1);
  });

  it('round-trips an empty chunk payload', () => {
    const chunk = Buffer.alloc(0);
    const frame = encodeFileChunkFrame({ transferId: 'tr-empty', seq: 2, eof: true }, chunk);

    const decoded = decodeFileChunkFrame(frame);

    expect(decoded.data.length).toBe(0);
    expect(decoded.eof).toBe(true);
  });

  it('preserves a large transferId and binary chunk content', () => {
    const transferId = 'a'.repeat(100);
    const chunk = Buffer.alloc(256 * 1024);
    for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31) & 0xff;

    const frame = encodeFileChunkFrame(
      {
        transferId,
        seq: 0,
        eof: true,
        totalSize: chunk.length,
        rangeStart: 0,
        rangeEnd: chunk.length - 1,
        contentType: 'application/x-test',
        fileName: 'test.bin',
      },
      chunk,
    );

    const decoded = decodeFileChunkFrame(frame);

    expect(decoded.transferId).toBe(transferId);
    expect(decoded.data.equals(chunk)).toBe(true);
  });

  it('rejects an unsupported version byte', () => {
    const chunk = Buffer.from('x');
    const frame = encodeFileChunkFrame({ transferId: 'tr-v', seq: 0, eof: true }, chunk);
    frame.writeUInt8(99, 0); // 篡改 version 字节

    expect(() => decodeFileChunkFrame(frame)).toThrow();
  });
});
