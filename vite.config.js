import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Keep the font a real file so the preload and @font-face share one cached request.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
