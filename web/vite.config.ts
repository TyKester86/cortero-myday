import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Local dev: the API runs on :4000; same-origin paths are proxied.
    proxy: {
      '/api': 'http://localhost:4000',
      '/dev-login': 'http://localhost:4000',
    },
  },
});
