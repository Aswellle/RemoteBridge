import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  main: {
    // better-sqlite3 为 native 模块，保持 external（dlopen hook 从 .cache/ 加载）。
    // 其余纯 JS 依赖打包进 bundle，避免 pnpm virtual store junction 在
    // 打包后的 app.asar 中无法解析（Cannot find module 'conf' 等传递依赖缺失）。
    plugins: [externalizeDepsPlugin({
      exclude: [
        '@remotebridge/shared',
        'axios',
        'electron-log',
        'electron-store',
        'electron-updater',
        'fastify',
        'nanoid',
        'ws',
      ],
    })],
    build: {
      outDir: 'dist/main',
      commonjsOptions: {
        include: [/packages[\\/]shared[\\/]dist/, /node_modules/],
      },
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/main/index.ts'),
        },
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
