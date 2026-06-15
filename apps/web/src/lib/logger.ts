// ===== 轻量日志封装 =====
// 浏览器端 SPA 的 console 输出本身没问题，这里只是为了让 debug/info 这类
// 详细追踪日志在生产环境静音，同时 warn/error 始终透传，方便排障。
// API 与 console.* 保持一致（variadic args），调用处直接替换即可。

function debug(...args: unknown[]): void {
  if (process.env.NODE_ENV === 'production') return;
  console.debug(...args);
}

function info(...args: unknown[]): void {
  if (process.env.NODE_ENV === 'production') return;
  console.info(...args);
}

function warn(...args: unknown[]): void {
  console.warn(...args);
}

function error(...args: unknown[]): void {
  console.error(...args);
}

export const logger = {
  debug,
  info,
  warn,
  error,
};
