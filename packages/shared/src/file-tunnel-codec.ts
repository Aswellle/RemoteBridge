/**
 * WS 文件隧道二进制帧编解码 (P1-12)
 *
 * 替代 RESP_FILE_CHUNK 原先的 JSON + base64 编码：每个非空分块编码为一个
 * 自描述二进制 WS 帧（固定头部 + 原始分块字节），避免
 * "Buffer → base64 字符串 → JSON.stringify"（编码端）和
 * "JSON.parse → Buffer.from(base64)"（解码端）这两轮额外的内存拷贝/分配
 * （详见 docs/file-tunnel-binary-framing-design.md）。
 *
 * 线缆格式：
 * ```
 * [0]       version (uint8) = 1
 * [1]       flags (uint8) — bit0=eof, bit1=hasMeta (true iff seq === 0)
 * [2-3]     transferIdLen (uint16 BE)
 * [...]     transferId (ASCII, length = transferIdLen)
 * [+0..3]   seq (uint32 BE)
 * -- if hasMeta:
 * [+0..7]   totalSize  (uint64 BE，拆成两个 uint32 BE 写入)
 * [+8..15]  rangeStart (uint64 BE)
 * [+16..23] rangeEnd   (uint64 BE)
 * [+24-25]  contentTypeLen (uint16 BE) + contentType bytes (UTF-8)
 * [+..]     fileNameLen (uint16 BE) + fileName bytes (UTF-8)
 * -- remaining bytes: chunk payload
 * ```
 *
 * 实际文件大小远小于 2^53，uint64 字段按两个 uint32 BE 半字写入/读取即可，
 * 全程使用普通 JS number。
 */

const VERSION = 1;

const FLAG_EOF = 0b01;
const FLAG_HAS_META = 0b10;

/** 首帧（seq === 0）携带的文件元信息；后续分块帧省略 */
export interface FileChunkFrameMeta {
  transferId: string;
  seq: number;
  eof: boolean;
  /** 文件总大小（字节）；仅 seq === 0 时写入帧 */
  totalSize?: number;
  /** 本次传输实际覆盖的字节范围（含端点）；仅 seq === 0 时写入帧 */
  rangeStart?: number;
  rangeEnd?: number;
  /** MIME 类型；仅 seq === 0 时写入帧 */
  contentType?: string;
  fileName?: string;
}

/** decodeFileChunkFrame 的解码结果；data 始终为 Buffer（与 JSON 路径解码后的形态一致） */
export interface DecodedFileChunkFrame {
  transferId: string;
  seq: number;
  eof: boolean;
  data: Buffer;
  totalSize?: number;
  rangeStart?: number;
  rangeEnd?: number;
  contentType?: string;
  fileName?: string;
}

// ===== uint64 (两个 uint32 BE 半字) 读写辅助 =====
function writeUInt64BE(buf: Buffer, value: number, offset: number): void {
  const high = Math.floor(value / 0x100000000);
  const low = value % 0x100000000;
  buf.writeUInt32BE(high, offset);
  buf.writeUInt32BE(low, offset + 4);
}

function readUInt64BE(buf: Buffer, offset: number): number {
  const high = buf.readUInt32BE(offset);
  const low = buf.readUInt32BE(offset + 4);
  return high * 0x100000000 + low;
}

/**
 * 将一个文件分块编码为自描述二进制 WS 帧。
 * @param meta 帧元信息（transferId/seq/eof，以及 seq === 0 时的文件元数据）
 * @param chunk 原始分块字节；可为空 Buffer（但空文件场景仍走 JSON 路径，不会调用本函数）
 */
export function encodeFileChunkFrame(meta: FileChunkFrameMeta, chunk: Buffer): Buffer {
  const transferIdBytes = Buffer.from(meta.transferId, 'ascii');
  const hasMeta = meta.seq === 0;

  let metaBytes: Buffer | null = null;
  let contentTypeBytes: Buffer | null = null;
  let fileNameBytes: Buffer | null = null;

  if (hasMeta) {
    contentTypeBytes = Buffer.from(meta.contentType ?? '', 'utf-8');
    fileNameBytes = Buffer.from(meta.fileName ?? '', 'utf-8');
    metaBytes = Buffer.alloc(24 + 2 + contentTypeBytes.length + 2 + fileNameBytes.length);
    writeUInt64BE(metaBytes, meta.totalSize ?? 0, 0);
    writeUInt64BE(metaBytes, meta.rangeStart ?? 0, 8);
    writeUInt64BE(metaBytes, meta.rangeEnd ?? 0, 16);
    metaBytes.writeUInt16BE(contentTypeBytes.length, 24);
    contentTypeBytes.copy(metaBytes, 26);
    metaBytes.writeUInt16BE(fileNameBytes.length, 26 + contentTypeBytes.length);
    fileNameBytes.copy(metaBytes, 26 + contentTypeBytes.length + 2);
  }

  const headerLen = 1 + 1 + 2 + transferIdBytes.length + 4;
  const header = Buffer.alloc(headerLen);
  let offset = 0;
  header.writeUInt8(VERSION, offset);
  offset += 1;

  let flags = 0;
  if (meta.eof) flags |= FLAG_EOF;
  if (hasMeta) flags |= FLAG_HAS_META;
  header.writeUInt8(flags, offset);
  offset += 1;

  header.writeUInt16BE(transferIdBytes.length, offset);
  offset += 2;
  transferIdBytes.copy(header, offset);
  offset += transferIdBytes.length;

  header.writeUInt32BE(meta.seq, offset);

  const parts: Uint8Array[] = [header];
  if (metaBytes) parts.push(metaBytes);
  parts.push(chunk);

  return Buffer.concat(parts);
}

/** 解码一个二进制 WS 帧。data 始终为 Buffer（与 JSON 路径解码后的形态一致） */
export function decodeFileChunkFrame(buf: Buffer): DecodedFileChunkFrame {
  let offset = 0;
  const version = buf.readUInt8(offset);
  offset += 1;
  if (version !== VERSION) {
    throw new Error(`不支持的文件隧道二进制帧版本: ${version}`);
  }

  const flags = buf.readUInt8(offset);
  offset += 1;
  const eof = (flags & FLAG_EOF) !== 0;
  const hasMeta = (flags & FLAG_HAS_META) !== 0;

  const transferIdLen = buf.readUInt16BE(offset);
  offset += 2;
  const transferId = buf.toString('ascii', offset, offset + transferIdLen);
  offset += transferIdLen;

  const seq = buf.readUInt32BE(offset);
  offset += 4;

  const result: DecodedFileChunkFrame = {
    transferId,
    seq,
    eof,
    data: Buffer.alloc(0),
  };

  if (hasMeta) {
    result.totalSize = readUInt64BE(buf, offset);
    offset += 8;
    result.rangeStart = readUInt64BE(buf, offset);
    offset += 8;
    result.rangeEnd = readUInt64BE(buf, offset);
    offset += 8;

    const contentTypeLen = buf.readUInt16BE(offset);
    offset += 2;
    result.contentType = buf.toString('utf-8', offset, offset + contentTypeLen);
    offset += contentTypeLen;

    const fileNameLen = buf.readUInt16BE(offset);
    offset += 2;
    result.fileName = buf.toString('utf-8', offset, offset + fileNameLen);
    offset += fileNameLen;
  }

  result.data = buf.subarray(offset);
  return result;
}
