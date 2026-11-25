import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  root: 'apps/web',
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4174', '/artifacts': 'http://127.0.0.1:4174' },
  },
  build: { outDir: '../../dist', emptyOutDir: true },
});
