import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    hookTimeout: 10000,
    include: ['test/**/*.test.ts'],
    // P1-15: 自动拉起 relay（临时 RB_DATA_DIR），不再要求手动启动 :3099 实例
    globalSetup: ['./test/global-setup.ts'],
  },
});
