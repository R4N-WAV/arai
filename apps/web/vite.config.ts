import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs under `wrangler dev` (port 8787); Vite proxies
// /api so the app stays same-origin exactly as in production.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: false } } },
  worker: { format: 'es' },
  // No data: URIs: the CSP only allows same-origin fonts and images.
  build: {
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: { index: 'index.html', sw: 'src/sw.ts' },
      // The streaming service worker must live at the site root (/sw.js) to control every page.
      output: { entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js') },
    },
  },
});
