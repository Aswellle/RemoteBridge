import jwt from 'jsonwebtoken';
import { JWT_CONFIG } from '@remotebridge/shared';

// ===== JWT 密钥 =====
// 生产环境应从环境变量读取；默认值/派生值仅供开发使用 —— 生产环境（NODE_ENV=production）
// 由 utils/secrets.ts 的启动校验拒绝使用这两个回退值
export const DEFAULT_JWT_SECRET = 'remotebridge-dev-secret-change-in-production';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
// refresh token 使用独立密钥：即使 access 密钥泄露，30 天长效凭证也不受影响（反之亦然）
// SM1: 独立的 refresh 密钥回退值，不从 access 密钥派生，防止 access 泄露同时暴露 refresh
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'remotebridge-refresh-dev-secret-change-in-production';

// ===== Token Payload 接口 =====
export interface HostTokenPayload {
  sub: string;      // hostId
  type: 'host';
}

export interface ClientTokenPayload {
  sub: string;      // clientId
  type: 'client';
  sessionId: string;
  hostId: string;
  /** refresh token 专属标记；access token 不携带，防止 refresh token 被直接当 access token 使用 */
  use?: 'refresh';
}

export type TokenPayload = HostTokenPayload | ClientTokenPayload;

// ===== 签发 Host JWT =====
export function signHostToken(hostId: string): string {
  const payload: HostTokenPayload = {
    sub: hostId,
    type: 'host',
  };

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_CONFIG.HOST_TOKEN_EXPIRY,
  });
}

// ===== 签发 Client Access Token =====
export function signClientAccessToken(clientId: string, sessionId: string, hostId: string): string {
  const payload: ClientTokenPayload = {
    sub: clientId,
    type: 'client',
    sessionId,
    hostId,
  };

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_CONFIG.ACCESS_TOKEN_EXPIRY,
  });
}

// ===== 签发 Client Refresh Token =====
export function signClientRefreshToken(clientId: string, sessionId: string, hostId: string): string {
  const payload: ClientTokenPayload = {
    sub: clientId,
    type: 'client',
    sessionId,
    hostId,
    use: 'refresh',
  };

  return jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: JWT_CONFIG.REFRESH_TOKEN_EXPIRY,
  });
}

// ===== 验证 JWT =====
export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}

// ===== 验证 Access Token（拒绝 refresh token 冒用） =====
export function verifyAccessToken(token: string): TokenPayload {
  const payload = verifyToken(token);
  if ((payload as ClientTokenPayload).use === 'refresh') {
    throw new Error('Refresh token cannot be used as access token');
  }
  return payload;
}

// ===== 验证 Host Token（仅校验类型；Host token 不带 use 字段，refresh 检查无意义） =====
export function verifyHostToken(token: string): HostTokenPayload {
  const payload = verifyToken(token);
  if (payload.type !== 'host') {
    throw new Error('Invalid token type');
  }
  return payload;
}

// ===== 验证 Refresh Token（独立密钥 + use 标记双重校验） =====
export function verifyRefreshToken(token: string): ClientTokenPayload {
  const payload = jwt.verify(token, JWT_REFRESH_SECRET) as ClientTokenPayload;
  if (payload.type !== 'client' || payload.use !== 'refresh') {
    throw new Error('Not a refresh token');
  }
  return payload;
}

// ===== 从请求头提取 Token =====
export function extractTokenFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

// ===== 从请求中提取 Token（Authorization 头优先，其次 rb_access cookie）=====
// 用于支持 httpOnly cookie 认证（02a-S11）的路由；Host/桌面端走 Bearer 头，
// Web 客户端走 cookie，两条路径都能通过同一个函数提取。
export function extractTokenFromRequest(headers: {
  authorization?: string;
  cookie?: string;
}): string | null {
  const fromHeader = extractTokenFromHeader(headers.authorization);
  if (fromHeader) return fromHeader;
  const cookieHeader = headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)rb_access=([^;]*)/);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return null;
      }
    }
  }
  return null;
}
