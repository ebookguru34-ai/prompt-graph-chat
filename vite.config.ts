import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const PROXY_PORT = Number(process.env.PROXY_PORT || 5174);
export default defineConfig({
  plugins: [react()],
  preview: { proxy: { '/kobold': `http://127.0.0.1:${PROXY_PORT}`, '/tts': `http://127.0.0.1:${PROXY_PORT}` } },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT || 5173),
    proxy: { '/kobold': { target: `http://127.0.0.1:${PROXY_PORT}`, changeOrigin: true }, '/tts': { target: `http://127.0.0.1:${PROXY_PORT}`, changeOrigin: true } },
  },
});
