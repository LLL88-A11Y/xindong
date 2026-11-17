import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.EDGEONE_PREVIEW_ASSET_PREFIX,
});
