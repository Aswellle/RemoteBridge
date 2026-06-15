import { WSMessage, WSMessageType } from '@remotebridge/shared';
import type { RespFileChunkPayload, RespFileErrorPayload, DecodedFileChunkFrame } from '@remotebridge/shared';

/**
 * 文件隧道传输注册表（Relay 代理 ↔ Host）。
 *
 * 代理路由发出 CMD_FETCH_FILE 前先在此登记 transferId；
 * ws/handler 收到 RESP_FILE_CHUNK / RESP_FILE_ERROR（JSON 路径）或二进制分块帧
 * （P1-12，见 file-tunnel-codec.ts）时分别交由 resolveFileTunnelMessage /
 * resolveFileTunnelBinaryFrame 分发——这些消息只属于服务端，永不中继给 Client。
 * 每帧到达都会重置空闲计时器；超时视为 Host 中断，由 onError 收尾。
 *
 * 两条路径最终都规范化为同一内部形态（data: Buffer），onChunk 消费者
 * （routes/proxy.ts::tunnelFromHost）无需区分来源。
 */

/** onChunk 收到的归一化分块；data 始终为 Buffer，与 RespFileChunkPayload 字段对齐但去掉了 base64 字符串 */
export type NormalizedFileChunk = Omit<RespFileChunkPayload, 'data'> & { data: Buffer };

interface ActiveTransfer {
  onChunk: (chunk: NormalizedFileChunk) => void;
  onError: (err: Error) => void;
  idleTimeoutMs: number;
  timer: NodeJS.Timeout;
}

const transfers = new Map<string, ActiveTransfer>();

function armTimer(transferId: string, transfer: ActiveTransfer): void {
  clearTimeout(transfer.timer);
  transfer.timer = setTimeout(() => {
    transfers.delete(transferId);
    transfer.onError(new Error('文件隧道传输超时（Host 无响应）'));
  }, transfer.idleTimeoutMs);
}

/** 登记一次传输。必须在向 Host 发送 CMD_FETCH_FILE【之前】调用 */
export function beginFileTransfer(
  transferId: string,
  handlers: {
    onChunk: (chunk: NormalizedFileChunk) => void;
    onError: (err: Error) => void;
  },
  idleTimeoutMs: number = 30000,
): void {
  const transfer: ActiveTransfer = {
    onChunk: handlers.onChunk,
    onError: handlers.onError,
    idleTimeoutMs,
    timer: setTimeout(() => {}, 0),
  };
  transfers.set(transferId, transfer);
  armTimer(transferId, transfer);
}

/** 主动结束（HTTP 客户端断开等场景）。后续到达的残余分块会被静默丢弃 */
export function endFileTransfer(transferId: string): void {
  const transfer = transfers.get(transferId);
  if (transfer) {
    clearTimeout(transfer.timer);
    transfers.delete(transferId);
  }
}

/** 分块到达（任一格式）的共用收尾逻辑：到 eof 清理传输，否则续期空闲计时器 */
function deliverChunk(transferId: string, transfer: ActiveTransfer, chunk: NormalizedFileChunk): void {
  if (chunk.eof) {
    clearTimeout(transfer.timer);
    transfers.delete(transferId);
  } else {
    armTimer(transferId, transfer);
  }
  transfer.onChunk(chunk);
}

/** 由 ws/handler 调用（JSON 路径）；返回 true 表示消息已被隧道消费（或属于已结束的传输，应丢弃） */
export function resolveFileTunnelMessage(message: WSMessage): boolean {
  if (message.type !== WSMessageType.RESP_FILE_CHUNK && message.type !== WSMessageType.RESP_FILE_ERROR) {
    return false;
  }

  const transferId = (message.payload as { transferId?: string } | undefined)?.transferId;
  // 隧道消息即使无主（传输已被清理）也必须拦下，绝不能流向 Client
  if (!transferId) return true;

  const transfer = transfers.get(transferId);
  if (!transfer) return true;

  if (message.type === WSMessageType.RESP_FILE_ERROR) {
    clearTimeout(transfer.timer);
    transfers.delete(transferId);
    const payload = message.payload as RespFileErrorPayload;
    transfer.onError(new Error(payload.message || 'Host 文件读取失败'));
    return true;
  }

  const payload = message.payload as RespFileChunkPayload;
  // legacy 路径：base64 解码一次，归一化为 Buffer，与二进制路径输出形态一致
  deliverChunk(transferId, transfer, { ...payload, data: Buffer.from(payload.data, 'base64') });
  return true;
}

/**
 * 由 ws/handler 调用（二进制路径，P1-12）；解码后的帧已含 data: Buffer，无需 base64。
 * 与 resolveFileTunnelMessage 共享 transfers 注册表/计时器逻辑。
 * 无主帧（传输已结束/超时）静默丢弃——二进制帧永不中继给 Client，无需返回值标识。
 */
export function resolveFileTunnelBinaryFrame(decoded: DecodedFileChunkFrame): void {
  const transfer = transfers.get(decoded.transferId);
  if (!transfer) return;

  const chunk: NormalizedFileChunk = {
    transferId: decoded.transferId,
    seq: decoded.seq,
    eof: decoded.eof,
    data: decoded.data,
    totalSize: decoded.totalSize,
    rangeStart: decoded.rangeStart,
    rangeEnd: decoded.rangeEnd,
    contentType: decoded.contentType,
    fileName: decoded.fileName,
  };
  deliverChunk(decoded.transferId, transfer, chunk);
}

/** 当前进行中的传输数（监控/测试用） */
export function activeTransferCount(): number {
  return transfers.size;
}
