/**
 * REST API 类型定义
 * RemoteBridge 服务器接口类型
 */

// ===== 通用响应格式 =====
export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T | null;
  error: ApiError | null;
  timestamp: number;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

// ===== 认证模块 =====
export interface RegisterHostRequest {
  name: string;
  os: string;
  version: string;
}

export interface RegisterHostResponse {
  hostId: string;
  secret: string;
}

export interface GeneratePinRequest {
  expiresIn: number;
}

export interface GeneratePinResponse {
  pin: string;
  expiresAt: number;
}

export interface ConnectRequest {
  pin: string;
  clientId: string;
  clientLabel: string;
}

export interface ConnectResponse {
  sessionId: string;
  hostInfo: HostInfo;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
}

// ===== 主机信息 =====
export interface HostInfo {
  hostId: string;
  name: string;
  os: string;
  online: boolean;
  lastSeen?: number;
  version?: string;
}

// ===== 客户端信息 =====
export interface ClientInfo {
  clientId: string;
  /** 该客户端当前活跃会话的 sessionId —— 吊销（DELETE /auth/revoke/:sessionId）必须用它，不是 clientId */
  sessionId: string;
  label: string;
  lastSeenAt: number;
  isTrusted: boolean;
  online: boolean;
  revokedAt?: number;
}

// ===== 会话信息 =====
export interface SessionInfo {
  id: string;
  hostId: string;
  clientId: string;
  clientLabel?: string;
  createdAt: number;
  lastActiveAt?: number;
  revokedAt?: number;
}

// ===== 消息 =====
export interface Message {
  id: string;
  sessionId: string;
  direction: 'host_to_client' | 'client_to_host';
  content: string;
  type: 'text' | 'system' | 'notification';
  createdAt: number;
  readAt?: number;
}

// ===== 共享目录 =====
export interface AllowedDirectory {
  id: number;
  path: string;
  label?: string;
  permission: 'readonly' | 'download';
  recursive: boolean;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

// ===== 下载令牌 =====
export interface DownloadToken {
  token: string;
  filePath: string;
  clientId: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
  downloadCount: number;
}

// ===== 安全日志 =====
export interface SecurityLog {
  id: string;
  hostId?: string;
  clientId?: string;
  eventType: 'AUTH_FAIL' | 'BLOCKED_PATH' | 'REVOKE' | 'PIN_EXPIRED' | 'SESSION_CREATED' | 'ACCESS_DOWNLOAD' | 'ACCESS_PREVIEW' | 'ACCESS';
  detail?: string;
  ipAddress?: string;
  createdAt: number;
}

// ===== 访问日志 =====
export interface AccessLog {
  id: number;
  clientId: string;
  action: 'LIST_DIR' | 'LIST_ALLOWED' | 'DOWNLOAD' | 'PREVIEW' | 'TUNNEL_FETCH';
  path?: string;
  status: 'OK' | 'BLOCKED' | 'ERROR';
  createdAt: number;
}
