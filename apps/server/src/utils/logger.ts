import pino from 'pino';

// ===== 独立日志实例 =====
// 供没有 Fastify app/request 作用域的模块使用（db/client.ts 在 app 创建前运行，
// ws/relay.ts、ws/handler.ts 的内部 helper 不持有 app/request 引用）。
// 日志级别与 index.ts 的 Fastify logger.level 共用同一环境变量，保持两者一致。
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
});
