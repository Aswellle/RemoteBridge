import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ===== hosts 表 =====
export const hosts = sqliteTable('hosts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  os: text('os'),
  version: text('version'),
  pinHash: text('pin_hash').notNull(),
  pinExpiresAt: integer('pin_expires_at'),
  lastSeenAt: integer('last_seen_at'),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch())`),
  isBanned: integer('is_banned')
    .notNull()
    .default(0),
});

// ===== sessions 表 =====
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  hostId: text('host_id')
    .notNull()
    .references(() => hosts.id),
  clientId: text('client_id').notNull(),
  clientLabel: text('client_label'),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch())`),
  revokedAt: integer('revoked_at'),
  lastActiveAt: integer('last_active_at'),
});

// ===== messages 表 =====
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id),
  direction: text('direction', { enum: ['host_to_client', 'client_to_host'] }).notNull(),
  content: text('content').notNull(),
  type: text('type', { enum: ['text', 'system', 'notification'] })
    .notNull()
    .default('text'),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch())`),
  readAt: integer('read_at'),
}, (table) => ({
  sessionCreatedIdx: index('idx_messages_session_created').on(table.sessionId, table.createdAt),
}));

// ===== security_logs 表 =====
export const securityLogs = sqliteTable('security_logs', {
  id: text('id').primaryKey(),
  hostId: text('host_id').references(() => hosts.id),
  clientId: text('client_id'),
  eventType: text('event_type', {
    enum: ['AUTH_FAIL', 'BLOCKED_PATH', 'REVOKE', 'PIN_EXPIRED', 'SESSION_CREATED', 'ACCESS_DOWNLOAD', 'ACCESS_PREVIEW', 'ACCESS'],
  }).notNull(),
  detail: text('detail'),
  ipAddress: text('ip_address'),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => ({
  hostCreatedIdx: index('idx_security_logs_host_created').on(table.hostId, table.createdAt),
}));

// ===== 类型导出 =====
export type Host = typeof hosts.$inferSelect;
export type NewHost = typeof hosts.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type SecurityLog = typeof securityLogs.$inferSelect;
export type NewSecurityLog = typeof securityLogs.$inferInsert;
