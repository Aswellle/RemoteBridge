// 必须在所有其他模块之前加载
// Electron 28 需要不同编译版本的 better-sqlite3 native 模块
// 此 hook 拦截 process.dlopen，将 better-sqlite3 的 .node 加载重定向到 Electron 预编译版本
import fs from 'fs';
import path from 'path';
import log from './logger';

if (process.versions?.electron) {
  // 查找 .cache 中的 Electron 预编译版本
  const projectRoot = (() => {
    // __dirname 在 bundled 模式下为 dist/main/
    let dir = __dirname;
    // 尝试回退到项目根（从 dist/main → apps/desktop → 项目根）
    for (let i = 0; i < 10; i++) {
      const cachePath = path.join(dir, '.cache', 'better_sqlite3.electron.node');
      if (fs.existsSync(cachePath)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  })();

  const electronBinding = projectRoot
    ? path.join(projectRoot, '.cache', 'better_sqlite3.electron.node')
    : null;

  if (electronBinding && fs.existsSync(electronBinding)) {
    const electronBindingResolved = path.resolve(electronBinding);
    // @ts-ignore - process.dlopen 是 Node.js 内部 API
    const origDlopen = process.dlopen;
    // @ts-ignore
    process.dlopen = function (module: any, filename: string, ...args: any[]) {
      if (typeof filename === 'string' && filename.includes('better_sqlite3')) {
        // 将被拦截的文件路径替换为 Electron 版本
        const alt = electronBindingResolved;
        try {
          return origDlopen.call(this, module, alt, ...args);
        } catch (err) {
          log.warn('加载 Electron 版 better-sqlite3 二进制失败，回退到原始路径:', (err as Error).message);
        }
      }
      return origDlopen.call(this, module, filename, ...args);
    };
  }
}
