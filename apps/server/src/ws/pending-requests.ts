import { WSMessage, WSMessageType } from '@remotebridge/shared';

/**
 * 服务端发起的 Host 请求的统一等待注册表。
 *
 * 取代旧实现（每个代理请求往 hostWs 上挂一个临时 'message' 监听器）：
 * 监听器数量不再随并发请求增长，响应分发统一走 ws/handler 的消息循环，
 * 与 relay 正常路由解耦 —— handler 在 RESP_* 分支先调用 resolvePendingRequest，
 * 命中则该响应属于服务端（代理）请求，不再向 Client 中继。
 */

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  successType: WSMessageType;
  errorTypes: WSMessageType[];
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingRequest>();

/** 注册等待。必须在向 Host 发送请求【之前】调用，避免响应先于注册到达 */
export function waitForHostResponse(
  requestId: string,
  successType: WSMessageType,
  errorTypes: WSMessageType[],
  timeoutMs: number = 10000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Host 响应超时'));
    }, timeoutMs);

    pending.set(requestId, { resolve, reject, successType, errorTypes, timer });
  });
}

/** 由 ws/handler 在收到 RESP_* 时调用；返回 true 表示该响应已被服务端请求消费 */
export function resolvePendingRequest(message: WSMessage): boolean {
  const requestId = (message.payload as { requestId?: string } | undefined)?.requestId;
  if (!requestId) return false;

  const req = pending.get(requestId);
  if (!req) return false;

  if (message.type === req.successType) {
    clearTimeout(req.timer);
    pending.delete(requestId);
    req.resolve(message.payload);
    return true;
  }

  if (req.errorTypes.includes(message.type as WSMessageType)) {
    clearTimeout(req.timer);
    pending.delete(requestId);
    req.reject(new Error((message.payload as { message?: string } | undefined)?.message || 'Host 处理失败'));
    return true;
  }

  return false;
}

/** 当前等待中的请求数（监控/测试用） */
export function pendingRequestCount(): number {
  return pending.size;
}
