import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The webhook server (`node serve.js`, or `gift serve`) has to be running
// separately for `pnpm dev` to show data — Vite only serves the frontend.
// /api and /health are proxied to it so fetch('/api/status') in the React app
// reaches that server instead of Vite's own dev server.
const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3999';

// Root is this file's directory (web/), so index.html and src/ resolve from
// here regardless of the working directory `pnpm run build` is invoked from.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': API_PROXY_TARGET,
      '/health': API_PROXY_TARGET,
    },
  },
});
