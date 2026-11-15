import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

// GitHub Pages serves the site from /pocket-pixels/ (and so does `vite preview`
// of the build); the dev server serves from /.
export default defineConfig(({ command, isPreview }) => ({
  base: command === "build" || isPreview ? "/pocket-pixels/" : "/",
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "Pocket Pixels",
        short_name: "Pocket Pixels",
        description: "8-bit Texas Hold'em against computer opponents. Play chips only.",
        theme_color: "#0d1b2a",
        background_color: "#0d1b2a",
        display: "standalone",
        orientation: "portrait",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Cache everything the game needs, including the font, so it plays offline.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
  },
}));
