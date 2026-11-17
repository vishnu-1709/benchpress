import { defineConfig } from 'vite';

// base './' so the built site works on GitHub Pages (/benchpress/), Cloudflare Pages or any static host.
export default defineConfig({
  base: './',
  worker: { format: 'iife' },
  build: { target: 'es2022', outDir: 'dist' },
  test: { environment: 'node' },
} as any);
