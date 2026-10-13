import { defineConfig } from 'vite';

// npm run dev: фронт на :5173, /api проксируется в запущенный стек.
export default defineConfig({
  server: {
    proxy: { '/api': { target: 'https://localhost:8443', changeOrigin: true, secure: false } },
  },
});
