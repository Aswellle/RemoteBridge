import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';

// 确保数据目录存在（支持环境变量 RB_DATA_DIR 自定义路径）
const dataDir = process.env.RB_DATA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.remotebridge', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// 创建数据库连接
const dbPath = path.join(dataDir, 'remotebridge.db');
const sqlite = new Database(dbPath);

// 启用 WAL 模式提高并发性能
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// 创建 Drizzle 实例
export const db = drizzle(sqlite, { schema });

// SM6: 同步会话吊销检查（用于 WS 连接升级阶段，早于消息处理器注册）
export function isSessionRevoked(sessionId: string): boolean {
  const row = sqlite.prepare(
    'SELECT revoked_at FROM sessions WHERE id = ?'
  ).get(sessionId) as { revoked_at: number | null } | undefined;
  return !row || row.revoked_at != null;
}

// ===== 初始化数据库表 =====
export function initDatabase(): void {
  logger.info('初始化数据库...');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS hosts (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      os            TEXT,
      version       TEXT,
      pin_hash      TEXT NOT NULL,
      pin_expires_at INTEGER,
      last_seen_at  INTEGER,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      is_banned     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      host_id       TEXT NOT NULL REFERENCES hosts(id),
      client_id     TEXT NOT NULL,
      client_label  TEXT,
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at    INTEGER NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      revoked_at    INTEGER,
      last_active_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES sessions(id),
      direction     TEXT NOT NULL CHECK (direction IN ('host_to_client','client_to_host')),
      content       TEXT NOT NULL,
      type          TEXT NOT NULL DEFAULT 'text',
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      read_at       INTEGER
    );

    CREATE TABLE IF NOT EXISTS security_logs (
      id            TEXT PRIMARY KEY,
      host_id       TEXT REFERENCES hosts(id),
      client_id     TEXT,
      event_type    TEXT NOT NULL,
      detail        TEXT,
      ip_address    TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_security_logs_host_created ON security_logs(host_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_client_host ON sessions(client_id, host_id);
  `);

  logger.info('数据库初始化完成');
}

// ===== 数据保留任务 =====
// security_logs / messages 无限增长会拖慢全表扫描查询并阻塞单一事件循环；
// 保留 90 天数据，每天清理一次（镜像 routes/auth.ts 的 rateLimitCleaner 模式）
const RETENTION_DAYS = 90;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 500; // PH2: 每批最多删除行数，防止单次大量 DELETE 阻塞事件循环

// PH2: 分批异步删除，每批 500 行后让出事件循环，防止大表清理时心跳/WS 超时
export async function runRetentionCleanup(): Promise<{ securityLogs: number; messages: number }> {
  const cutoffSeconds = RETENTION_DAYS * 24 * 60 * 60;
  let totalSecurityLogs = 0;
  let totalMessages = 0;
  const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  const deleteSecLogs = sqlite.prepare(
    'DELETE FROM security_logs WHERE id IN (SELECT id FROM security_logs WHERE created_at < unixepoch() - ? LIMIT ?)'
  );
  let slDone = false;
  while (!slDone) {
    const r = deleteSecLogs.run(cutoffSeconds, CLEANUP_BATCH_SIZE);
    totalSecurityLogs += r.changes;
    if (r.changes < CLEANUP_BATCH_SIZE) slDone = true;
    else await yieldLoop();
  }

  const deleteMsgs = sqlite.prepare(
    'DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE created_at < unixepoch() - ? LIMIT ?)'
  );
  let msgDone = false;
  while (!msgDone) {
    const r = deleteMsgs.run(cutoffSeconds, CLEANUP_BATCH_SIZE);
    totalMessages += r.changes;
    if (r.changes < CLEANUP_BATCH_SIZE) msgDone = true;
    else await yieldLoop();
  }

  return { securityLogs: totalSecurityLogs, messages: totalMessages };
}

export function startRetentionJob(): void {
  const run = async () => {
    try {
      const result = await runRetentionCleanup();
      if (result.securityLogs > 0 || result.messages > 0) {
        logger.info({ securityLogs: result.securityLogs, messages: result.messages }, '数据保留清理完成');
      }
    } catch (err) {
      logger.error({ err }, '数据保留清理失败');
    }
  };

  void run();
  const cleaner = setInterval(() => { void run(); }, RETENTION_INTERVAL_MS);
  cleaner.unref?.();
}

// ===== 健康检查统计 =====
// /health 用此函数确认数据库可写，并报告 messages / security_logs 等表的行数
// 与数据库文件大小，便于在保留任务（见上）失效导致无限增长时尽早发现。
export interface DbHealthStats {
  ok: boolean;
  error?: string;
  sizeBytes?: number;
  tables?: {
    hosts: number;
    sessions: number;
    messages: number;
    securityLogs: number;
  };
}

// PL2: 缓存健康检查结果 5 秒，避免高频 /health 轮询每次触发多次同步 DB 写操作
let cachedHealthStats: DbHealthStats | null = null;
let healthCacheExpiry = 0;

export function getHealthStats(): DbHealthStats {
  if (cachedHealthStats && Date.now() < healthCacheExpiry) {
    return cachedHealthStats;
  }
  try {
    // 写性能检查：WAL 模式下普通查询不足以暴露磁盘满/只读等问题
    sqlite.prepare('CREATE TABLE IF NOT EXISTS _health_check (id INTEGER PRIMARY KEY)').run();
    sqlite.prepare('DELETE FROM _health_check').run();
    sqlite.prepare('INSERT INTO _health_check (id) VALUES (1)').run();

    const count = (table: string): number =>
      (sqlite.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number }).count;

    const result: DbHealthStats = {
      ok: true,
      sizeBytes: fs.statSync(dbPath).size,
      tables: {
        hosts: count('hosts'),
        sessions: count('sessions'),
        messages: count('messages'),
        securityLogs: count('security_logs'),
      },
    };
    cachedHealthStats = result;
    healthCacheExpiry = Date.now() + 5000;
    return result;
  } catch (err) {
    logger.error({ err }, '数据库健康检查失败');
    return { ok: false, error: '数据库健康检查失败' };
  }
}

// 导出数据库实例和 schema
export { schema };
export default db;
