import { nanoid } from 'nanoid';

// ===== 短生命期 WS 票据（02a-S11）=====
// Web 客户端无法在 WS URL 中安全传递 httpOnly cookie，因此先通过 REST 换取一个
// 30 秒单次使用的随机票据，再用 ?ticket= 建立 WebSocket 连接。
// Host（桌面端）不使用此机制，继续沿用 ?token= 路径。

interface WsTicket {
  clientId: string;
  sessionId: string;
  hostId: string;
  expiresAt: number;
}

const tickets = new Map<string, WsTicket>();

/** 签发一个 30 秒单次票据，返回票据字符串。 */
export function issueTicket(clientId: string, sessionId: string, hostId: string): string {
  const ticket = nanoid(32);
  tickets.set(ticket, { clientId, sessionId, hostId, expiresAt: Date.now() + 30_000 });
  return ticket;
}

/** 兑换票据。命中则删除并返回数据；未找到或已过期返回 null。 */
export function redeemTicket(ticket: string): WsTicket | null {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  if (Date.now() > entry.expiresAt) return null;
  return entry;
}

/** 启动定期清理过期票据的定时器（每 60 秒一次）。 */
export function startTicketCleaner(): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of tickets) {
      if (now > entry.expiresAt) tickets.delete(key);
    }
  }, 60_000);
}
