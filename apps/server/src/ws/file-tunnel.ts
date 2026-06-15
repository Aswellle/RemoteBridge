import { WSMessage, WSMessageType } from '@remotebridge/shared';
import type { RespFileChunkPayload, RespFileErrorPayload } from '@remotebridge/shared';

/**
 * 文件隧道传输注册表（Relay 代理 ↔ Host）。
 *
 * 代理路由发出 CMD_FETCH_FILE 前先在此登记 transferId；
 * ws/handler 收到 RESP_FILE_CHUNK / RESP_FILE_ERROR 时交由 resolveFileTunnelMessage
 * 分发——这两类消息只属于服务端，永不中继给 Client。
 * 每帧到达都会重置空闲计时器；超时视为 Host 中断，由 onError 收尾。
 */

interface ActiveTransfer {
  onChunk: (payload: RespFileChunkPayload) => void;
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
    onChunk: (payload: RespFileChunkPayload) => void;
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

/** 由 ws/handler 调用；返回 true 表示消息已被隧道消费（或属于已结束的传输，应丢弃） */
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
  if (payload.eof) {
    clearTimeout(transfer.timer);
    transfers.delete(transferId);
  } else {
    armTimer(transferId, transfer);
  }
  transfer.onChunk(payload);
  return true;
}

/** 当前进行中的传输数（监控/测试用） */
export function activeTransferCount(): number {
  return transfers.size;
}
