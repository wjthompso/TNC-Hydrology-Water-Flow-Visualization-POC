import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    chunkSizeWarningLimit: 2000,
  },
  optimizeDeps: {
    exclude: ['@arcgis/core'],
  },
});
