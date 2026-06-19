import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { builtinModules } from 'module';
import type { Plugin } from 'rollup';

// main 进程只排除 electron 本身和 Node.js 内置模块。
// better-sqlite3 的 JS 代码打包进 bundle，其 native .node 的加载通过
// bindingsStubPlugin + electron-binding.ts 的 dlopen hook 重定向到
// resources/.cache/better_sqlite3.electron.node（由 extraResources 复制）。
const MAIN_EXTERNALS: (string | RegExp)[] = [
  'electron',
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
];

// 将 require('bindings') 替换为直接调用 process.dlopen。
// electron-binding.ts 的 dlopen hook 会拦截包含模块名的路径，
// 并将加载重定向到 resources/.cache/<name>.node（Electron 预编译版本）。
function bindingsStubPlugin(): Plugin {
  return {
    name: 'stub-bindings',
    resolveId(source: string) {
      if (source === 'bindings') return '\0stub:bindings';
      return null;
    },
    load(id: string) {
      if (id === '\0stub:bindings') {
        return [
          `'use strict';`,
          `const path = require('path');`,
          `module.exports = function bindings(name) {`,
          `  const m = { exports: {}, id: name, loaded: false };`,
          `  process.dlopen(m, path.join(__dirname, name + '.node'));`,
          `  m.loaded = true;`,
          `  return m.exports;`,
          `};`,
        ].join('\n');
      }
      return null;
    },
  };
}

export default defineConfig({
  main: {
    plugins: [bindingsStubPlugin()],
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
