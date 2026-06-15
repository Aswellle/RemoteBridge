import log from 'electron-log/main';

// 日志级别来源：LOG_LEVEL 环境变量，与服务端约定一致（process.env.LOG_LEVEL ?? 'info'）；
// 渲染端可配置的级别设置留作后续工作（见 docs/observability-logging-design.md 的 open question）。
const level = (process.env.LOG_LEVEL as typeof log.transports.file.level) || 'info';
log.transports.file.level = level;
log.transports.console.level = level;

export default log;
