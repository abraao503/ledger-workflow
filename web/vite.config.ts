import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: {
    outDir: '../dist/interfaces/web/public',
    emptyOutDir: true,
  },
  esbuild: {
    jsx: 'automatic',
  },
});
