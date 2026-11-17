import { defineConfig } from 'vite';
import vueJsx from '@vitejs/plugin-vue-jsx';
import { fileURLToPath } from 'node:url';
import { Agent } from 'node:http';

const apiProxy = { target: process.env.ECHO_DEV_API_TARGET ?? 'http://127.0.0.1:3000', changeOrigin: true, agent: new Agent({ keepAlive: false }) };

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vueJsx()],
  server: { host: '127.0.0.1', port: 3100, proxy: { '/api': apiProxy, '/health': apiProxy } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
