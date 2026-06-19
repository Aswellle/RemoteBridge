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
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer'),
      },
    },
  },
});
