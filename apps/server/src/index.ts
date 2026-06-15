import { readFileSync } from 'fs';
import { join } from 'path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { initDatabase, startRetentionJob, getHealthStats } from './db/client';
import { validateJwtSecrets } from './utils/secrets';
import { authRoutes } from './routes/auth';
import { hostsRoutes } from './routes/hosts';
import { messagesRoutes } from './routes/messages';
import { securityLogsRoutes } from './routes/security-logs';
import { proxyRoutes } from './routes/proxy';
import { setupWebSocket } from './ws/handler';
import { CORS_OPTIONS } from './utils/cors';

// ===== 环境变量 =====
const PORT = parseInt(process.env.RELAY_PORT || '3001', 10);
const HOST = process.env.RELAY_HOST || '0.0.0.0';

// ===== 应用版本（来自 package.json，避免 /health 硬编码版本号与实际不一致） =====
const APP_VERSION = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')).version as string;

// ===== 创建 Fastify 实例 =====
const app = Fastify({
  logger: {
    level: 'info',
  },
});

// ===== 注册插件 =====
async function registerPlugins() {
  // CORS（策略统一定义在 utils/cors.ts，proxy 隧道的手动补头与之共享）
  await app.register(cors, CORS_OPTIONS);

  // 限流（global: false — 仅对显式声明 config.rateLimit 的路由生效，见 routes/auth.ts）
  await app.register(rateLimit, {
    global: false,
    // 抛出的对象需自带 statusCode，否则 Fastify 默认错误处理会回退到 500；
    // 本项目未启用 ban 选项，respCtx.statusCode 恒为 429
    errorResponseBuilder: () => ({
      statusCode: 429,
      success: false,
      data: null,
      error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' },
      timestamp: Date.now(),
    }),
  });

  // WebSocket
  await app.register(websocket);
}

// ===== 注册路由 =====
async function registerRoutes() {
  // 健康检查（含数据库可写性检查与表行数/体积统计，便于尽早发现无限增长）
  app.get('/health', async (_request, reply) => {
    const db = getHealthStats();

    if (!db.ok) {
      reply.code(503);
      return {
        status: 'error',
        timestamp: Date.now(),
        version: APP_VERSION,
        db,
      };
    }

    return {
      status: 'ok',
      timestamp: Date.now(),
      version: APP_VERSION,
      db,
    };
  });

  // API 状态
  app.get('/api/v1/status', async () => {
    return {
      success: true,
      data: {
        uptime: process.uptime(),
        timestamp: Date.now(),
      },
    };
  });

  // 认证路由
  await app.register(authRoutes, { prefix: '/api/v1' });

  // Host 信息路由
  await app.register(hostsRoutes, { prefix: '/api/v1' });

  // 消息路由
  await app.register(messagesRoutes, { prefix: '/api/v1' });

  // 安全日志路由
  await app.register(securityLogsRoutes, { prefix: '/api/v1' });

  // 文件代理路由
  await app.register(proxyRoutes, { prefix: '/api/v1' });
}

// ===== 启动服务器 =====
async function start() {
  try {
    // 生产环境下校验 JWT 密钥强度，配置不安全则拒绝启动
    validateJwtSecrets();

    // 初始化数据库
    initDatabase();

    // 启动数据保留清理任务（90 天，每天一次）
    startRetentionJob();

    // 注册插件和路由
    await registerPlugins();
    await registerRoutes();

    // 设置 WebSocket 处理
    setupWebSocket(app);

    // 启动服务器
    await app.listen({ port: PORT, host: HOST });

    app.log.info(`🚀 RemoteBridge Relay Server 启动于 http://${HOST}:${PORT}`);
    app.log.info(`📡 WebSocket 端点: ws://${HOST}:${PORT}/ws`);
    app.log.info(`🔗 健康检查: http://${HOST}:${PORT}/health`);
    app.log.info(`🔐 认证 API: http://${HOST}:${PORT}/api/v1/auth/*`);
    app.log.info(`👥 主机 API: http://${HOST}:${PORT}/api/v1/hosts/*`);
    app.log.info(`💬 消息 API: http://${HOST}:${PORT}/api/v1/messages/*`);
    app.log.info(`🔒 安全日志 API: http://${HOST}:${PORT}/api/v1/security-logs`);
    app.log.info(`📁 文件代理 API: http://${HOST}:${PORT}/api/v1/proxy/*`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// 处理优雅关闭
async function shutdown(signal: string): Promise<void> {
  app.log.info(`收到 ${signal} 信号，正在关闭...`);
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
