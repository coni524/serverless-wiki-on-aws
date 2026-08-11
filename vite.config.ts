import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Stamped into the bundle as the persisted-cache buster: a cache written by
  // one build is discarded by the next, so a response shape change never meets
  // data persisted in the old shape.
  define: {
    __BUILD_ID__: JSON.stringify(new Date().toISOString())
  },
  resolve: {
    conditions: ['browser'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    outDir: 'dist'
  }
});
