import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Only measure files that have corresponding tests; type-only files
      // (ws-types.ts, api-types.ts, security-log-ui.ts) have no logic to test.
      include: ['src/file-utils.ts', 'src/security.ts', 'src/file-tunnel-codec.ts'],
      reporter: ['text-summary', 'lcov'],
      // CD-H1: threshold gate — fail CI if core utility coverage drops below these levels
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
    },
  },
});
