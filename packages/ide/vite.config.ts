import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  server: {
    port: 5173,
    // COOP/COEP so SharedArrayBuffer works if/when we start running wasm
    // in-browser from this page. Harmless for the server-compile path.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      '/api': 'http://localhost:8787',
      '/vendor': 'http://localhost:8787',
    },
  },
  plugins: [react()],
});
