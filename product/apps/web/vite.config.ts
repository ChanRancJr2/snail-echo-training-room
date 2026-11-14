import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { Agent } from 'node:http';

const apiProxy = { target: 'http://127.0.0.1:3000', changeOrigin: true, agent: new Agent({ keepAlive: false }) };

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 3100, proxy: { '/api': apiProxy, '/health': apiProxy } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
