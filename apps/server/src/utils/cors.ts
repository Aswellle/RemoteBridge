import type { FastifyCorsOptions } from '@fastify/cors';

// ===== CORS 策略（唯一定义点） =====
// 两个消费方必须保持同一来源策略：
// 1. index.ts 注册 @fastify/cors 插件（覆盖所有常规路由）；
// 2. routes/proxy.ts 的隧道响应 —— reply.hijack() 之后插件的 onSend 钩子
//    不再执行，必须用 corsHeadersFor() 手动补头，否则浏览器拦截代理下载/预览。
// 修改策略只改这里。

export const ALLOWED_ORIGINS: string[] =
  process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:9666'];

// @fastify/cors 插件选项
// 验证 origin 是否在白名单或 localhost，不再反射任意 Origin
function validateOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (origin.includes('localhost') || origin.includes('127.0.0.1')) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

export const CORS_OPTIONS: FastifyCorsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (validateOrigin(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
};

// 为接管（hijack）的原始响应手动生成 CORS 头；来源不在白名单时返回空对象
// （不带头 = 浏览器拦截，与插件对未授权来源的行为一致）
export function corsHeadersFor(origin: string | undefined): Record<string, string> {
  if (!origin) return {};
  // 允许 localhost 任意端口 + 白名单
  if (origin.includes('localhost') || origin.includes('127.0.0.1') || ALLOWED_ORIGINS.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    };
  }
  return {};
}
