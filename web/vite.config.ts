import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // asset-manifest.json lists every built file, so the service worker can cache them all for offline.
  build: { manifest: 'asset-manifest.json' },
  server: {
    // Local dev: the API runs on :4000; same-origin paths are proxied.
    proxy: {
      '/api': 'http://localhost:4000',
      '/dev-login': 'http://localhost:4000',
    },
  },
});
