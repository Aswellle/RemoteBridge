import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 内联空 PostCSS 配置，阻止 Vite 搜索并加载 apps/desktop/postcss.config.js——
  // 该文件引入 tailwindcss，其依赖 picocolors 在当前 pnpm store 中缺失，
  // 会导致 vitest 在配置解析阶段直接崩溃（与本测试套件无关）。
  css: {
    postcss: {},
  },
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
  },
});
