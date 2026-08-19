import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { builtinModules } from 'module';

// main 进程只排除 electron 本身和 Node.js 内置模块。
// better-sqlite3（含 bindings）的 JS 代码打包进 bundle；
// bindings 内部的动态 require('.node') 通过 ignoreDynamicRequires 保留为运行时调用，
// electron-binding.ts 的 Module._resolveFilename hook 在文件存在性检查之前将其
// 重定向到 resources/.cache/better_sqlite3.electron.node（由 extraResources 复制）。
const MAIN_EXTERNALS: (string | RegExp)[] = [
  'electron',
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
  // ws 的可选原生 addon，未安装时 ws 会 try/catch 跳过；必须声明为 external
  // 否则 Rollup 在打包时会因找不到而报错
  'bufferutil',
  'utf-8-validate',
];

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      commonjsOptions: {
        include: [/packages[\\/]shared[\\/]dist/, /node_modules/],
        // 保留动态 require(variable) 为运行时调用，而非替换为抛错的 commonjsRequire。
        // bindings 包计算 .node 文件路径时需要此选项；
        // electron-binding.ts 的 Module._resolveFilename hook 负责运行时重定向。
        ignoreDynamicRequires: true,
      },
      rollupOptions: {
        input: { index: path.resolve(__dirname, 'src/main/index.ts') },
        external: MAIN_EXTERNALS,
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    root: path.resolve(__dirname, 'src/renderer'),
    build: {
      outDir: 'dist/renderer',
      commonjsOptions: {
        include: [/packages[\\/]shared[\\/]dist/, /node_modules/],
      },
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
    // 监听所有接口（IPv4 + IPv6），避免 Electron Chromium 先尝试 IPv4 127.0.0.1
    // 时 Vite 仅绑定 IPv6 [::1] 导致 ERR_CONNECTION_REFUSED 白屏。
    server: {
      host: true,
      port: 5173,
    },
    // dev 模式下强制预打包 @remotebridge/shared：
    // shared 以 CommonJS 编译输出（__exportStar），Vite 若不预打包会通过 /@fs/ 直接
    // 导致 "does not provide an export named 'EVENT_TYPE_COLORS'" SyntaxError，
    // 进而让整个 React 应用在挂载前崩溃（白屏）。
    optimizeDeps: {
      include: ['@remotebridge/shared'],
    },
    // shared 包编译为 CJS，模块求值时引用 process.platform / process.env（Node 专属）。
    // 渲染端（浏览器环境）没有 process，通过 define 注入桩值避免 "process is not defined"。
    // 渲染端实际不调用这些 Node-only 函数（仅使用 EVENT_TYPE_COLORS 等常量），桩值仅用于通过模块求值。
    define: {
      'process.platform': JSON.stringify(process.platform),
      'process.env': '{}',
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer'),
        // 将 workspace 软链指向根目录外的 shared 包直接解析到 dist 产物，
        // 避免 Vite 因路径在项目根外而跳过优化（/@fs/ 直读 CJS 导致白屏）。
        '@remotebridge/shared': path.resolve(__dirname, '../../packages/shared/dist/index.js'),
      },
    },
  },
});
