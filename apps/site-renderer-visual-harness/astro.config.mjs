import { defineConfig } from 'astro/config';

export default defineConfig({
  outDir: process.env.OUT_DIR ?? './dist',
  devToolbar: { enabled: false },
  trailingSlash: 'ignore',
});
