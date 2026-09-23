/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { skinotePwa } from './pwa/skinote-pwa.ts';

// base './' keeps the build relocatable: GitHub Pages sub-path (/skinote/), a desktop wrapper, or the shop server.
// The app routes with the location hash (#/ledger/2026-12-26), so no server rewrite is needed.
// skinotePwa writes manifest.webmanifest and sw.js (precache of the built app shell and fonts, relative scope); build only.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    skinotePwa({
      tokensCss: new URL('../../packages/ui/src/styles/tokens.css', import.meta.url).pathname,
      serviceWorker: new URL('./pwa/sw.js', import.meta.url).pathname,
    }),
  ],
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['test/**/*.test.{ts,tsx}'] },
});
