import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.PORT ?? 3000);

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  plugins: [react()],
  build: {
    outDir: '../../dist/public',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: false,
        // Large uploads can take a long time; don't let the dev proxy time out.
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
});
