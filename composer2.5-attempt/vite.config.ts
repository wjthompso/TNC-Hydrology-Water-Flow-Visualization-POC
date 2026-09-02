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
  server: {
    proxy: {
      '/api/usgs-elevation': {
        target:
          'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/usgs-elevation/, ''),
      },
    },
  },
});
