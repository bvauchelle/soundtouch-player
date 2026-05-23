import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Dev: Vite serves the SPA on 5173 and proxies API calls to Express on 5010.
// Prod: `npm run build` outputs `dist/`, which server.js serves as static.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/play': 'http://localhost:5010',
      '/stop': 'http://localhost:5010',
      '/state': 'http://localhost:5010',
      '/volume': 'http://localhost:5010',
      '/status': 'http://localhost:5010',
      '/station.json': 'http://localhost:5010',
      '/api': 'http://localhost:5010',
    },
  },
  build: { outDir: 'dist' },
});
