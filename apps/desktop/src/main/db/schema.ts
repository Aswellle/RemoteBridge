// ===== 数据库表结构定义 =====

export const CREATE_ALLOWED_DIRECTORIES = `
  CREATE TABLE IF NOT EXISTS allowed_directories (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    path          TEXT NOT NULL UNIQUE,
    label         TEXT,
    permission    TEXT NOT NULL DEFAULT 'download',
    recursive     INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    is_active     INTEGER NOT NULL DEFAULT 1
  );
`;

export const CREATE_CONNECTED_CLIENTS = `
  CREATE TABLE IF NOT EXISTS connected_clients (
    id            TEXT PRIMARY KEY,
    label         TEXT,
    last_seen_at  INTEGER,
    is_trusted    INTEGER NOT NULL DEFAULT 0,
    revoked_at    INTEGER,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

export const CREATE_DOWNLOAD_TOKENS = `
  CREATE TABLE IF NOT EXISTS download_tokens (
    token         TEXT PRIMARY KEY,
    file_path     TEXT NOT NULL,
    client_id     TEXT NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at    INTEGER NOT NULL,
    used_at       INTEGER,
    download_count INTEGER NOT NULL DEFAULT 0
  );
`;

export const CREATE_LOCAL_MESSAGES = `
  CREATE TABLE IF NOT EXISTS local_messages (
    id            TEXT PRIMARY KEY,
    session_id    TEXT,
    direction     TEXT NOT NULL CHECK (direction IN ('host_to_client','client_to_host')),
    content       TEXT NOT NULL,
    type          TEXT NOT NULL DEFAULT 'text',
    sender_id     TEXT,
    sender_label  TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

export const CREATE_ACCESS_LOGS = `
  CREATE TABLE IF NOT EXISTS access_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id     TEXT NOT NULL,
    action        TEXT NOT NULL,
    path          TEXT,
    status        TEXT NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

export const ALL_TABLES = [
  CREATE_ALLOWED_DIRECTORIES,
  CREATE_CONNECTED_CLIENTS,
  CREATE_DOWNLOAD_TOKENS,
  CREATE_LOCAL_MESSAGES,
  CREATE_ACCESS_LOGS,
].join('\n');
