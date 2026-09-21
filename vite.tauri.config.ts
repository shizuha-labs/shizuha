import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import * as path from 'node:path';

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve('src/web/index-tauri.html'),
    },
  },
  // Tauri expects the dev server on port 1420
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      '/v1': 'http://127.0.0.1:8016',
      '/health': 'http://127.0.0.1:8016',
      '/ws': { target: 'ws://127.0.0.1:8016', ws: true },
    },
  },
  // Prevent vite from obscuring rust errors
  clearScreen: false,
  // Env variables starting with TAURI_ are exposed to tauri's source code
  envPrefix: ['VITE_', 'TAURI_'],
});
