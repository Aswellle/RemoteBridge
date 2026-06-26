import { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { hosts } from '../db/schema';

// ===== 连接元数据（挂载在 WebSocket.__meta 上） =====
export interface ConnectionMeta {
  type: 'host' | 'client';
  id: string;          // hostId 或 clientId
  sessionId?: string;
  hostId?: string;
  lastPong: number;
  clientLabel?: string;
  connectedAt?: number;
}

// ===== 连接元数据 WeakMap（类型安全替代 (ws as any).__meta） =====
const connMeta = new WeakMap<WebSocket, ConnectionMeta>();

export function getConnMeta(ws: WebSocket): ConnectionMeta | undefined {
  return connMeta.get(ws);
}

export function setConnMeta(ws: WebSocket, meta: ConnectionMeta): void {
  connMeta.set(ws, meta);
}

// ===== 房间状态（唯一持有者，不对外暴露原始 Map） =====
const hostSockets = new Map<string, WebSocket>();    // hostId -> WebSocket
const clientSockets = new Map<string, WebSocket>();  // clientId -> WebSocket
const sessionRooms = new Map<string, string>();       // clientId -> hostId
// PM1: hostId -> Set<clientId> 反向索引，将 getHostClients/forEachClientOfHost 从 O(n) 降为 O(1)
const hostClients = new Map<string, Set<string>>();  // hostId -> Set<clientId>

// ===== Host =====
export function registerHost(hostId: string, ws: WebSocket): void {
  hostSockets.set(hostId, ws);
}

// 重连竞态保护：仅当房间里登记的还是 expected 这个 socket 才移除，
// 否则说明新连接已覆盖该条目，旧 socket 的 close 不应误删新连接
export function unregisterHost(hostId: string, expected: WebSocket): boolean {
  if (hostSockets.get(hostId) !== expected) return false;
  hostSockets.delete(hostId);
  return true;
}

export function getHostSocket(hostId: string): WebSocket | undefined {
  return hostSockets.get(hostId);
}

export function isHostOnline(hostId: string): boolean {
  return hostSockets.has(hostId);
}

export function forEachHost(fn: (hostId: string, ws: WebSocket) => void): void {
  hostSockets.forEach((ws, hostId) => fn(hostId, ws));
}

// ===== Client =====
export function registerClient(clientId: string, ws: WebSocket, hostId?: string): void {
  clientSockets.set(clientId, ws);
  if (hostId) {
    sessionRooms.set(clientId, hostId);
    if (!hostClients.has(hostId)) hostClients.set(hostId, new Set());
    hostClients.get(hostId)!.add(clientId);
  }
}

export function unregisterClient(clientId: string, expected: WebSocket): boolean {
  if (clientSockets.get(clientId) !== expected) return false;
  clientSockets.delete(clientId);
  const hostId = sessionRooms.get(clientId);
  sessionRooms.delete(clientId);
  if (hostId) {
    hostClients.get(hostId)?.delete(clientId);
    if (hostClients.get(hostId)?.size === 0) hostClients.delete(hostId);
  }
  return true;
}

export function getClientSocket(clientId: string): WebSocket | undefined {
  return clientSockets.get(clientId);
}

export function isClientOnline(clientId: string): boolean {
  return clientSockets.has(clientId);
}

export function forEachClient(fn: (clientId: string, ws: WebSocket) => void): void {
  clientSockets.forEach((ws, clientId) => fn(clientId, ws));
}

// ===== 房间映射（clientId -> hostId） =====
export function getClientHost(clientId: string): string | null {
  return sessionRooms.get(clientId) || null;
}

export function getHostClients(hostId: string): string[] {
  return Array.from(hostClients.get(hostId) ?? []);
}

// Host（重）上线时，为其已连接的 Client 重建房间映射
export function rebindClientToHost(clientId: string, hostId: string): void {
  const oldHostId = sessionRooms.get(clientId);
  if (oldHostId && oldHostId !== hostId) {
    hostClients.get(oldHostId)?.delete(clientId);
    if (hostClients.get(oldHostId)?.size === 0) hostClients.delete(oldHostId);
  }
  sessionRooms.set(clientId, hostId);
  if (!hostClients.has(hostId)) hostClients.set(hostId, new Set());
  hostClients.get(hostId)!.add(clientId);
}

export function forEachClientOfHost(hostId: string, fn: (clientId: string, ws: WebSocket) => void): void {
  getHostClients(hostId).forEach((clientId) => {
    const ws = clientSockets.get(clientId);
    if (ws) fn(clientId, ws);
  });
}

// Host 下线：移除其所有 Client 的房间映射，返回受影响的 clientId 列表
export function clearHostClients(hostId: string): string[] {
  const clients = getHostClients(hostId);
  clients.forEach((clientId) => sessionRooms.delete(clientId));
  hostClients.delete(hostId);
  return clients;
}

// 优雅关闭：清空所有房间状态
export function clearAll(): void {
  hostSockets.clear();
  clientSockets.clear();
  sessionRooms.clear();
  hostClients.clear();
}

// ===== 房间信息（聚合 Host 名称 + 已连接 Client 列表） =====
export interface RoomInfo {
  hostId: string;
  hostName: string;
  clients: Array<{
    clientId: string;
    clientLabel?: string;
    connectedAt: number;
  }>;
}

export async function getRoomInfo(hostId: string): Promise<RoomInfo | null> {
  if (!isHostOnline(hostId)) return null;

  const clients: RoomInfo['clients'] = [];
  forEachClientOfHost(hostId, (clientId, ws) => {
    const meta = getConnMeta(ws);
    clients.push({
      clientId,
      clientLabel: meta?.clientLabel,
      connectedAt: meta?.connectedAt || Date.now(),
    });
  });

  const host = await db.select({ name: hosts.name }).from(hosts).where(eq(hosts.id, hostId)).limit(1);

  return {
    hostId,
    hostName: host[0]?.name ?? '',
    clients,
  };
}
