export const RELAY_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002/api/v1';
export const RELAY_WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3002/ws';

// Web 端版本号：构建时由 next.config.mjs 从 package.json 注入（见该文件的 env 配置），
// 运行时上报给 Relay，Host 端据此展示 Web 端版本
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || 'unknown';
