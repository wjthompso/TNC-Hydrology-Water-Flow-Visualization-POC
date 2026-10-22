import { defineConfig } from 'vite';
import { modeledWaterDataPlugin } from './vite-plugins/modeled-water-data-plugin';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  // Dev-only: serves the git-ignored modeled water pipeline output under
  // /modeled-water-surface-elevation-data/<extent>/ without copying it to public/.
  plugins: [modeledWaterDataPlugin()],
  build: {
    chunkSizeWarningLimit: 2000,
    // src/main.ts uses top-level await (the timeline-fixture branch); Vite's default es2020 target rejects it.
    target: 'es2022',
  },
  optimizeDeps: {
    exclude: ['@arcgis/core'],
  },
  server: {
    port: process.env.PORT ? parseInt(process.env.PORT) : 5173,
    proxy: {
      // The USGS 3DEP ImageServer has no CORS headers for localhost. The custom
      // elevation layer fetches tiles through this same-origin path instead.
      '/api/usgs-elevation': {
        target:
          'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/usgs-elevation/, ''),
      },
    },
  },
});
