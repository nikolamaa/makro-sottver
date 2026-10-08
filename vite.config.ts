import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./src/web', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/web', import.meta.url));
const apiPort = Number(process.env.MACROPILOT_PORT ?? 4317);

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir, emptyOutDir: true, sourcemap: false, target: 'es2022' },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
});
