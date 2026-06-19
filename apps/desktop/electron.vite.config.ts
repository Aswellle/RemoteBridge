import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { builtinModules } from 'module';

// main 进程只排除真正不能打包的东西：
//   - electron（运行时由 Electron 注入）
//   - better-sqlite3（native .node 文件，dlopen hook 处理）
//   - Node.js 内置模块（fs/path/os 等）
// 其余所有纯 JS 依赖（含 electron-store 及其传递依赖 conf/dot-prop 等）
// 全部内联进 bundle，避免 pnpm virtual store junction 在 ASAR 内不可解析。
const MAIN_EXTERNALS: (string | RegExp)[] = [
  'electron',
  'better-sqlite3',
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
];

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      commonjsOptions: {
        include: [/packages[\\/]shared[\\/]dist/, /node_modules/],
      },
      rollupOptions: {
        input: { index: path.resolve(__dirname, 'src/main/index.ts') },
        external: MAIN_EXTERNALS,
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer'),
      },
    },
  },
});
