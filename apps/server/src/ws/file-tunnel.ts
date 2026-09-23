import { WSMessage, WSMessageType, TransferState } from '@remotebridge/shared';
import type { TransferRecord } from '@remotebridge/shared';
import { db } from '../db/client';
import { securityLogs } from '../db/schema';
import { randomUUID } from 'node:crypto';
import type { RespFileChunkPayload, RespFileErrorPayload, DecodedFileChunkFrame, CmdCancelTransferPayload } from '@remotebridge/shared';
import { transferRegistry } from './transfer-registry';
/**
 * 文件隧道传输注册表（Relay 代理 ↔ Host）。
 *
 * V2 Transfer Engine: each transfer now has a proper state machine,
 * cancellation support, and session binding for revocation propagation.
 *
 * 代理路由发出 CMD_FETCH_FILE 在此之前在此登记 transferId；
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
  onChunk: (chunk: NormalizedFileChunk) => Promise<void> | void;
  onError: (err: Error) => void;
  idleTimeoutMs: number;
  timer: NodeJS.Timeout;
  state: TransferState;
  sessionId?: string;
  hostId?: string;
  clientId?: string;
  cancelReason?: CmdCancelTransferPayload['reason'];
  /** monotonic sequence guard */
  expectedSeq: number;
  receivedBytes: number;
  expectedBytes?: number;
}

const transfers = new Map<string, ActiveTransfer>();

function armTimer(transferId: string, transfer: ActiveTransfer): void {
  clearTimeout(transfer.timer);
  transfer.timer = setTimeout(() => {
    const t = transfers.get(transferId);
    if (t && t.state !== TransferState.CANCELLED && t.state !== TransferState.FAILED && t.state !== TransferState.COMPLETED) {
      t.state = TransferState.FAILED;
      t.cancelReason = 'timeout';
      t.onError(new Error('文件隧道传输超时（Host 无响应）'));
    }
    transfers.delete(transferId);
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
  sessionId?: string,
  hostId?: string,
  clientId?: string,
): void {
  const transfer: ActiveTransfer = {
    onChunk: handlers.onChunk,
    onError: handlers.onError,
    idleTimeoutMs,
    timer: setTimeout(() => {}, 0),
    state: TransferState.PENDING,
    sessionId,
    hostId,
    clientId,
    expectedSeq: 0,
    receivedBytes: 0,
  };
  transfers.set(transferId, transfer);
  armTimer(transferId, transfer);

  // P1-02: Register with unified Transfer Engine for state tracking
  transferRegistry.begin({
    transferId,
    direction: 'download',
    fileName: '', // will be updated on first frame
    mimeType: '',
    totalBytes: 0,
    state: TransferState.PENDING,
    sessionId,
    hostId,
    clientId,
  });
}

/**
 * Cancel a file transfer by id.
 * Idempotent: repeated calls are silently ignored.
 * Sets state to CANCELLED, fires onError, cleans up the registry.
 */
export function cancelFileTransfer(transferId: string, reason?: CmdCancelTransferPayload['reason']): boolean {
  const transfer = transfers.get(transferId);
  if (!transfer) return false;

  // Idempotent: already in a terminal state
  if (transfer.state === TransferState.CANCELLED || transfer.state === TransferState.FAILED || transfer.state === TransferState.COMPLETED) {
    return false;
  }

  clearTimeout(transfer.timer);
  // Audit log the cancellation (fire-and-forget; failure is non-fatal)
  if (transfer.sessionId && transfer.hostId) {
    void db.insert(securityLogs).values({
      id: randomUUID(),
      hostId: transfer.hostId,
      clientId: transfer.clientId,
      eventType: 'REVOKE',
      detail: JSON.stringify({ transferId, reason: reason ?? 'unknown' }),
      createdAt: Math.floor(Date.now() / 1000),
    }).catch(() => { /* audit log failure is non-fatal */ });
  }
  transfer.state = TransferState.CANCELLED;
  transfer.cancelReason = reason;
  transfer.onError(new Error('transfer cancelled: ' + (reason ?? 'unknown')));
  transfers.delete(transferId);
  transferRegistry.cancel(transferId, reason);
  return true;
}

/**
 * Cancel all transfers belonging to a session.
 * Returns the number of transfers cancelled.
 */
export function cancelTransfersBySession(sessionId: string, reason?: CmdCancelTransferPayload['reason']): number {
  let count = 0;
  for (const [transferId, transfer] of transfers) {
    if (transfer.sessionId === sessionId) {
      if (cancelFileTransfer(transferId, reason)) {
        count++;
      }
    }
  }
  // P1-02: Also cancel in unified Transfer Engine (covers transfers not in local map)
  transferRegistry.cancelSession(sessionId, reason);
  return count;
}

/** Get all active transfer IDs belonging to a session (for revoke notification to Host) */
export function getSessionTransferIds(sessionId: string): string[] {
  const ids: string[] = [];
  for (const [transferId, transfer] of transfers) {
    if (transfer.sessionId === sessionId) {
      ids.push(transferId);
    }
  }
  return ids;
}
/**
 * Get transfer state (for tests / observability).
 */
export function getFileTransfer(transferId: string): {
  state: TransferState;
  sessionId?: string;
  hostId?: string;
  clientId?: string;
  cancelReason?: string;
  transferredBytes: number;
  expectedBytes?: number;
} | undefined {
  const t = transfers.get(transferId);
  if (!t) return undefined;
  return {
    state: t.state,
    sessionId: t.sessionId,
    hostId: t.hostId,
    clientId: t.clientId,
    cancelReason: t.cancelReason,
    transferredBytes: t.receivedBytes,
    expectedBytes: t.expectedBytes,
  };
}

/** 主动结束（HTTP 客户端断开等场景）。后续到达的残余分块会被静默丢弃 */
export function endFileTransfer(transferId: string): void {
  const transfer = transfers.get(transferId);
  if (transfer) {
    clearTimeout(transfer.timer);
    transfer.state = TransferState.COMPLETED;
    transfers.delete(transferId);
    transferRegistry.complete(transferId);
  }
}
/** 分块到达（任一格式）的共用收尾逻辑：到 eof 清理传输，否则续期空闲计时器 */
async function deliverChunk(transferId: string, transfer: ActiveTransfer, chunk: NormalizedFileChunk): Promise<void> {
  // P1-02: Update unified Transfer Engine state
  if (transfer.state !== TransferState.STREAMING) {
    transferRegistry.markStreaming(transferId);
  }
  transferRegistry.recordBytes(transferId, chunk.data.length);

  if (chunk.eof) {
    // P0-03: Validate byte integrity before marking complete
    if (transfer.expectedBytes !== undefined && transfer.receivedBytes !== transfer.expectedBytes) {
      transfer.state = TransferState.FAILED;
      clearTimeout(transfer.timer);
      transfers.delete(transferId);
      transferRegistry.fail(transferId, 'integrity mismatch: expected ' + transfer.expectedBytes + ' bytes but received ' + transfer.receivedBytes, 'INTEGRITY_ERROR');
      transfer.onError(new Error(
        'integrity mismatch: expected ' + transfer.expectedBytes + ' bytes but received ' + transfer.receivedBytes,
      ));
      return;
    }
    clearTimeout(transfer.timer);
    transfer.state = TransferState.COMPLETED;
    transfers.delete(transferId);
    transferRegistry.complete(transferId);
  } else {
    armTimer(transferId, transfer);
  }
  await transfer.onChunk(chunk);
}

/** 由 ws/handler 调用（JSON 路径）；返回 true 表示消息已被隧道消费（或属于已结束的传输，应丢弃） */
export async function resolveFileTunnelMessage(message: WSMessage): Promise<boolean> {
  if (message.type !== WSMessageType.RESP_FILE_CHUNK && message.type !== WSMessageType.RESP_FILE_ERROR) {
    return false;
  }

  const transferId = (message.payload as { transferId?: string } | undefined)?.transferId;
  // 隧道消息即使无主（传输已被清理）也必须拦下，绝不能流向 Client
  if (!transferId) return true;

  const transfer = transfers.get(transferId);
  if (!transfer) return true;

  // P0-02: Discard chunks for cancelled transfers
  if (transfer.state === TransferState.CANCELLED || transfer.state === TransferState.FAILED) {
    return true;
  }

  // P0-03: Sequence validation
  const seq = (message.payload as { seq?: number } | undefined)?.seq;
  if (seq !== undefined && seq !== transfer.expectedSeq) {
    transfer.state = TransferState.FAILED;
    clearTimeout(transfer.timer);
    transfers.delete(transferId);
    transfer.onError(new Error(
      'sequence error: expected ' + transfer.expectedSeq + ' but got ' + seq,
    ));
    return true;
  }

  if (message.type === WSMessageType.RESP_FILE_ERROR) {
    clearTimeout(transfer.timer);
    transfer.state = TransferState.FAILED;
    transfers.delete(transferId);
    const payload = message.payload as RespFileErrorPayload;
    transfer.onError(new Error(payload.message || 'Host 文件读取失败'));
    return true;
  }

  const payload = message.payload as RespFileChunkPayload;

  // P0-03: Track bytes and sequence
  const chunkData = Buffer.from(payload.data, 'base64');
  transfer.receivedBytes += chunkData.length;
  if (seq !== undefined) transfer.expectedSeq = seq + 1;
  if (payload.totalSize !== undefined && payload.rangeStart !== undefined && payload.rangeEnd !== undefined) {
    transfer.expectedBytes = payload.rangeEnd - payload.rangeStart + 1;
  }

  transfer.state = TransferState.STREAMING;
  // legacy 路径：base64 解码一次，归一化为 Buffer，与二进制路径输出形态一致
  await deliverChunk(transferId, transfer, { ...payload, data: chunkData });
  return true;
}

/**
 * 由 ws/handler 调用（二进制路径，P1-12）；解码后的帧已含 data: Buffer，无需 base64。
 * 与 resolveFileTunnelMessage 共享 transfers 注册表/计时器逻辑。
 * 无主帧（传输已结束/超时）静默丢弃——二进制帧永不中继给 Client，无需返回值标识。
 */
export async function resolveFileTunnelBinaryFrame(decoded: DecodedFileChunkFrame): Promise<void> {
  const transfer = transfers.get(decoded.transferId);
  if (!transfer) return;

  // P0-02: Discard chunks for cancelled transfers
  if (transfer.state === TransferState.CANCELLED || transfer.state === TransferState.FAILED) {
    return;
  }

  // P0-03: Sequence validation
  if (decoded.seq !== transfer.expectedSeq) {
    transfer.state = TransferState.FAILED;
    clearTimeout(transfer.timer);
    transfers.delete(decoded.transferId);
    transfer.onError(new Error(
      'sequence error: expected ' + transfer.expectedSeq + ' but got ' + decoded.seq,
    ));
    return;
  }

  // P0-03: Track bytes and sequence
  transfer.receivedBytes += decoded.data.length;
  transfer.expectedSeq = decoded.seq + 1;
  if (decoded.totalSize !== undefined && decoded.rangeStart !== undefined && decoded.rangeEnd !== undefined) {
    transfer.expectedBytes = decoded.rangeEnd - decoded.rangeStart + 1;
  }

  transfer.state = TransferState.STREAMING;

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
  await deliverChunk(decoded.transferId, transfer, chunk);
}
/** 当前进行中的传输数（监控/测试用） */
export function activeTransferCount(): number {
  return transfers.size;
}
