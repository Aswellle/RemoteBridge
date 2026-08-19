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
    // 构造最小帧头：version=99（不支持），flags=0，transferIdLen=3，seq=0
    const header = Buffer.alloc(8);
    header.writeUInt8(99, 0);   // version
    header.writeUInt8(0, 1);    // flags
    header.writeUInt16BE(3, 2); // transferIdLen
    const transferId = Buffer.from('abc');
    const frame = Buffer.concat([header, transferId]);
    expect(() => decodeFileChunkFrame(frame)).toThrow(/版本/);
  });
});

describe('decodeFileChunkFrame — length validation (SEC)', () => {
  it('throws on a frame shorter than the 8-byte minimum header', () => {
    const buf = Buffer.alloc(5);
    expect(() => decodeFileChunkFrame(buf)).toThrow(/过短/);
  });

  it('throws when transferIdLen points past the buffer end', () => {
    const buf = Buffer.alloc(8);
    buf.writeUInt8(1, 0); // version
    buf.writeUInt8(0, 1); // flags (no meta)
    buf.writeUInt16BE(100, 2); // transferIdLen = 100, but only 6 bytes remain
    buf.writeUInt32BE(0, 4); // seq
    expect(() => decodeFileChunkFrame(buf)).toThrow(/截断/);
  });

  it('throws when a meta frame has an inflated contentTypeLen', () => {
    // Layout: ver(1) + flags(1) + transferIdLen(2) + transferId(2) + seq(4) +
    //         meta fixed(24) + contentTypeLen(2) = 36 bytes
    // contentTypeLen 声明 1000 字节，但读取后 offset(36) + 1000 > buf.length(36) → 截断
    const buf = Buffer.alloc(36);
    let o = 0;
    buf.writeUInt8(1, o); o += 1;            // version
    buf.writeUInt8(0b10, o); o += 1;         // flags: hasMeta
    buf.writeUInt16BE(2, o); o += 2;         // transferIdLen = 2
    o += 2;                                   // transferId bytes (未写入，为零)
    buf.writeUInt32BE(0, o); o += 4;         // seq = 0
    o += 24;                                  // meta fixed fields (totalSize/rangeStart/rangeEnd)
    buf.writeUInt16BE(1000, o);              // contentTypeLen = 1000 (超出缓冲区)
    expect(() => decodeFileChunkFrame(buf)).toThrow(/截断/);
  });
});
