import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          globals: true,
          include: ['src/server/**/*.test.ts', 'src/shared/**/*.test.ts', 'tests/server/**/*.test.ts'],
          testTimeout: 20000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          globals: true,
          include: ['src/web/**/*.test.{ts,tsx}'],
          setupFiles: ['./src/web/test-setup.ts'],
        },
      },
    ],
  },
});
