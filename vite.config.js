import { defineConfig } from 'vite';

// The web app lives in web/ and imports the engine from ../src, so the browser runs the same code as the tests.
export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
