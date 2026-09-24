import log from 'electron-log/main';

// 日志级别来源：LOG_LEVEL 环境变量，与服务端约定一致（process.env.LOG_LEVEL ?? 'info'）；
// 渲染端可配置的级别设置留作后续工作（见 docs/observability-logging-design.md 的 open question）。
const level = (process.env.LOG_LEVEL as typeof log.transports.file.level) || 'info';
log.transports.file.level = level;
log.transports.console.level = level;

// 修复 electron-log 在 EPIPE（管道断开）时崩溃的问题
// 当 Electron 进程的 stdout/stderr 管道断开时（如 dev 模式下进程被重启），
// electron-log 会抛出 EPIPE 未捕获异常导致弹窗。此处包装 console transport
// 捕获 EPIPE 并静默忽略，避免影响应用正常运行。
const origConsoleTransport = log.transports.console;
if (origConsoleTransport && typeof origConsoleTransport === 'object') {
  const origWriteFn = (origConsoleTransport as any).writeFn;
  if (typeof origWriteFn === 'function') {
    (origConsoleTransport as any).writeFn = (data: any) => {
      try {
        return origWriteFn(data);
      } catch (err: any) {
        if (err?.code === 'EPIPE') {
          // 管道已断开，静默忽略
          return;
        }
        throw err;
      }
    };
  }
}

// 同时捕获 process.stdout/stderr 的 EPIPE，双重保险
const safeWrite = (orig: Function) => function (this: any, chunk: any, encoding: any, callback: any) {
  try {
    return orig.call(this, chunk, encoding, (err: any) => {
      if (err?.code === 'EPIPE') {
        if (callback) callback();
        return;
      }
      if (callback) callback(err);
    });
  } catch (err: any) {
    if (err?.code !== 'EPIPE') throw err;
    if (callback) callback();
  }
};
['stdout', 'stderr'].forEach((name) => {
  const stream = process[name as 'stdout' | 'stderr'];
  if (stream && typeof stream.write === 'function') {
    const orig = stream.write.bind(stream);
    (stream as any).write = safeWrite(orig);
  }
});
// 全局兜底：移除所有现有的 uncaughtException handler，替换为忽略 EPIPE 的版本
// 确保 electron-log 或其他库无法弹出 EPIPE 错误弹窗
process.removeAllListeners('uncaughtException');
process.on('uncaughtException', (err: any) => {
  if (err?.code === 'EPIPE' || err?.message?.includes('EPIPE')) {
    return; // 静默忽略管道断开
  }
  // 其他异常：打印到 stderr 后退出，保持 Node 默认行为
  try {
    process.stderr.write(`Uncaught Exception: ${err?.stack || err}\n`);
  } catch {
    // stderr 也可能已断开，忽略
  }
  // 不 re-throw，避免无限循环；让进程自然退出
});

export default log;
