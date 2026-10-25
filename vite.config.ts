import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.PORT ?? 3000);

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  // The GitHub Pages demo is served from /<repo>/ (see scripts/build-pages.mjs).
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  build: {
    outDir: process.env.VITE_OUT_DIR ?? '../../dist/public',
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
