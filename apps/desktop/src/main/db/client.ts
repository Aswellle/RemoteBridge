import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { ALL_TABLES } from './schema';

// ===== 数据库路径 =====
const userDataPath = app.getPath('userData');
const dbDir = path.join(userDataPath, 'data');
const dbPath = path.join(dbDir, 'local.db');

// ===== 确保目录存在 =====
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// ===== 创建数据库连接 =====
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// ===== 初始化表结构 =====
// 导出供 main/index.ts 在 app.whenReady() 后显式调用，而非随模块加载自动执行
export function initDatabase(): void {
  sqlite.exec(ALL_TABLES);
}

// ===== 导出数据库操作 =====
export const db = {
  // --- 允许目录 ---
  getAllowedDirectories: () => {
    return sqlite.prepare('SELECT * FROM allowed_directories WHERE is_active = 1').all();
  },

  addAllowedDirectory: (path: string, label?: string, permission: string = 'download', recursive: boolean = true) => {
    const stmt = sqlite.prepare(
      'INSERT OR IGNORE INTO allowed_directories (path, label, permission, recursive) VALUES (?, ?, ?, ?)'
    );
    return stmt.run(path, label || null, permission, recursive ? 1 : 0);
  },

  removeAllowedDirectory: (id: number) => {
    return sqlite.prepare('UPDATE allowed_directories SET is_active = 0 WHERE id = ?').run(id);
  },

  updateDirectoryPermission: (id: number, permission: string) => {
    return sqlite.prepare(
      'UPDATE allowed_directories SET permission = ?, updated_at = unixepoch() WHERE id = ?'
    ).run(permission, id);
  },

  updateDirectoryAlias: (id: number, alias: string) => {
    return sqlite.prepare(
      'UPDATE allowed_directories SET label = ?, updated_at = unixepoch() WHERE id = ?'
    ).run(alias, id);
  },

  clearAllDirectories: () => {
    return sqlite.prepare('UPDATE allowed_directories SET is_active = 0').run();
  },

  // --- 连接的客户端 ---
  getConnectedClients: () => {
    return sqlite.prepare('SELECT * FROM connected_clients WHERE revoked_at IS NULL').all();
  },

  upsertConnectedClient: (id: string, label?: string) => {
    // COALESCE：事件不带 label 时保留已存的，避免覆盖为 null
    const stmt = sqlite.prepare(
      `INSERT INTO connected_clients (id, label, last_seen_at)
       VALUES (?, ?, unixepoch())
       ON CONFLICT(id) DO UPDATE SET label = COALESCE(?, label), last_seen_at = unixepoch()`
    );
    return stmt.run(id, label || null, label || null);
  },

  revokeClient: (id: string) => {
    return sqlite.prepare(
      'UPDATE connected_clients SET revoked_at = unixepoch() WHERE id = ?'
    ).run(id);
  },

  // --- 下载令牌 ---
  createDownloadToken: (token: string, filePath: string, clientId: string, expiresAt: number) => {
    const stmt = sqlite.prepare(
      'INSERT INTO download_tokens (token, file_path, client_id, expires_at) VALUES (?, ?, ?, ?)'
    );
    return stmt.run(token, filePath, clientId, expiresAt);
  },

  getDownloadToken: (token: string) => {
    return sqlite.prepare('SELECT * FROM download_tokens WHERE token = ?').get(token);
  },

  markTokenUsed: (token: string) => {
    return sqlite.prepare(
      'UPDATE download_tokens SET used_at = unixepoch(), download_count = download_count + 1 WHERE token = ?'
    ).run(token);
  },

  cleanExpiredTokens: () => {
    return sqlite.prepare('DELETE FROM download_tokens WHERE expires_at < unixepoch()').run();
  },

  // --- 访问日志 ---
  insertAccessLog: (log: { clientId: string; action: string; path?: string; status: string }) => {
    const stmt = sqlite.prepare(
      'INSERT INTO access_logs (client_id, action, path, status) VALUES (?, ?, ?, ?)'
    );
    return stmt.run(log.clientId, log.action, log.path || null, log.status);
  },

  getAccessLogs: (limit: number = 100) => {
    return sqlite.prepare('SELECT * FROM access_logs ORDER BY created_at DESC LIMIT ?').all(limit);
  },

  // --- 客户端信任（可信任/取消信任；客户端可能只存在于 relay 列表，先补一行再置位） ---
  setClientTrust: (id: string, trusted: boolean) => {
    sqlite.prepare(
      'INSERT OR IGNORE INTO connected_clients (id, last_seen_at) VALUES (?, unixepoch())'
    ).run(id);
    return sqlite.prepare(
      'UPDATE connected_clients SET is_trusted = ? WHERE id = ?'
    ).run(trusted ? 1 : 0, id);
  },

  // --- 本地消息 ---
  // OR IGNORE：id 使用 Relay 注入的原始消息 id，重复投递（重连重放等）天然去重
  insertMessage: (msg: { id: string; sessionId?: string; direction: string; content: string; type?: string; senderId?: string; senderLabel?: string }) => {
    const stmt = sqlite.prepare(
      'INSERT OR IGNORE INTO local_messages (id, session_id, direction, content, type, sender_id, sender_label) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    return stmt.run(msg.id, msg.sessionId || null, msg.direction, msg.content, msg.type || 'text', msg.senderId || null, msg.senderLabel || null);
  },

  getMessages: (limit: number = 100) => {
    return sqlite.prepare('SELECT * FROM local_messages ORDER BY created_at DESC LIMIT ?').all(limit);
  },
};

export default db;
