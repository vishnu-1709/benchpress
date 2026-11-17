import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

const hash = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'dev'; } })();

// base './' so the built site works on GitHub Pages (/benchpress/), Cloudflare Pages or any static host.
export default defineConfig({
  base: './',
  worker: { format: 'iife' },
  define: { __APP_VERSION__: JSON.stringify(`v0.1.1 · ${hash}`) },
  build: { target: 'es2022', outDir: 'dist' },
  test: { environment: 'node' },
} as any);
