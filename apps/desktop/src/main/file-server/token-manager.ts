import { nanoid } from 'nanoid';
import { db } from '../db/client';

// ===== 下载令牌接口 =====
export interface DownloadToken {
  token: string;
  filePath: string;
  clientId: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
  downloadCount: number;
}

// ===== 令牌配置 =====
const TOKEN_EXPIRY_MS = 30 * 60 * 1000; // 30 分钟

// ===== 创建下载令牌（写入数据库） =====
export function createDownloadToken(
  filePath: string,
  clientId: string,
  expiryMs: number = TOKEN_EXPIRY_MS
): DownloadToken {
  const token = nanoid(32);
  const now = Date.now();
  const expiresAt = now + expiryMs;

  // 持久化到数据库 —— 数据库统一存 Unix 秒
  // （validateDownloadToken 和 cleanExpiredTokens 都按秒比较；
  //   存毫秒会导致 token 永不过期、也永远清理不掉）
  db.createDownloadToken(token, filePath, clientId, Math.floor(expiresAt / 1000));

  return {
    token,
    filePath,
    clientId,
    createdAt: now,
    expiresAt,
    downloadCount: 0,
  };
}

// ===== 验证下载令牌（从数据库读取） =====
export function validateDownloadToken(
  token: string,
  clientId?: string
): { valid: boolean; token?: DownloadToken; reason?: string } {
  const row = db.getDownloadToken(token) as {
    token: string;
    file_path: string;
    client_id: string;
    created_at: number;
    expires_at: number;
    used_at: number | null;
    download_count: number;
  } | undefined;

  if (!row) {
    return { valid: false, reason: 'TOKEN_NOT_FOUND' };
  }

  if (row.expires_at < Math.floor(Date.now() / 1000)) {
    return { valid: false, reason: 'TOKEN_EXPIRED' };
  }

  if (row.download_count >= 1) {
    return { valid: false, reason: 'TOKEN_USED' };
  }

  if (clientId && row.client_id !== clientId) {
    return { valid: false, reason: 'CLIENT_MISMATCH' };
  }

  return {
    valid: true,
    token: {
      token: row.token,
      filePath: row.file_path,
      clientId: row.client_id,
      createdAt: row.created_at * 1000,
      expiresAt: row.expires_at * 1000,
      usedAt: row.used_at ? row.used_at * 1000 : undefined,
      downloadCount: row.download_count,
    },
  };
}

// ===== 标记令牌已使用（更新数据库） =====
export function markTokenUsed(token: string): void {
  db.markTokenUsed(token);
}

// ===== 清理过期令牌 =====
export function cleanExpiredTokens(): number {
  const result = db.cleanExpiredTokens();
  return result.changes ?? 0;
}
