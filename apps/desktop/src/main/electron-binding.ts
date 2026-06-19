// 必须在所有其他模块之前加载
// 拦截 Module._resolveFilename，将 better-sqlite3 的 .node 加载请求重定向到
// Electron 预编译版本，在 Node 检查文件是否存在之前就完成重定向，
// 因此原始路径不需要实际存在。
import Module from 'module';
import fs from 'fs';
import path from 'path';
import log from './logger';

if (process.versions?.electron) {
  // 查找 Electron 预编译版本：打包后优先用 process.resourcesPath，
  // 开发模式则从 __dirname 向上遍历查找 .cache/
  const electronBinary = (() => {
    if ((process as any).resourcesPath) {
      const p = path.join((process as any).resourcesPath, '.cache', 'better_sqlite3.electron.node');
      if (fs.existsSync(p)) return p;
    }
    let dir = __dirname;
    for (let i = 0; i < 10; i++) {
      const p = path.join(dir, '.cache', 'better_sqlite3.electron.node');
      if (fs.existsSync(p)) return p;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  })();

  if (electronBinary) {
    // 拦截 Module._resolveFilename：在 Node 发起文件存在性检查之前，
    // 将所有包含 better_sqlite3 的 .node 请求重定向到 Electron 预编译版本。
    // @ts-ignore
    const origResolve = Module._resolveFilename;
    // @ts-ignore
    Module._resolveFilename = function (request: string, ...args: any[]) {
      if (
        typeof request === 'string' &&
        request.includes('better_sqlite3') &&
        request.endsWith('.node')
      ) {
        return electronBinary;
      }
      return origResolve.call(this, request, ...args);
    };

    // dlopen hook 作为兜底（覆盖通过路径字面量直接 dlopen 的场景）
    // @ts-ignore
    const origDlopen = process.dlopen;
    // @ts-ignore
    process.dlopen = function (module: any, filename: string, ...args: any[]) {
      if (typeof filename === 'string' && filename.includes('better_sqlite3')) {
        try {
          return origDlopen.call(this, module, electronBinary, ...args);
        } catch (err) {
          log.warn('加载 Electron 版 better-sqlite3 失败，回退原始路径:', (err as Error).message);
        }
      }
      return origDlopen.call(this, module, filename, ...args);
    };

    log.info('better-sqlite3 重定向至:', electronBinary);
  } else {
    log.warn('未找到 better-sqlite3 Electron 预编译版本（.cache/better_sqlite3.electron.node），可能出现模块版本不匹配');
  }
}
