import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

// GitHub Pages serves the site from /pocket-pixels/ (and so does `vite preview`
// of the build); the dev server serves from /.
export default defineConfig(({ command, isPreview, mode }) => ({
  base: command === "build" || isPreview ? "/pocket-pixels/" : "/",
  plugins: [
    VitePWA({
      // The local multiplayer test build skips the offline cache so rebuilds show up.
      disable: mode === "localtest",
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "Pocket Pixels",
        short_name: "Pocket Pixels",
        description: "8-bit Texas Hold'em against bots or with friends online. Play chips only.",
        theme_color: "#05050f",
        background_color: "#05050f",
        // Android hides the status bar for a full-screen game; iOS treats
        // this as standalone and draws under its status bar (see index.html).
        display: "fullscreen",
        display_override: ["fullscreen", "standalone"],
        orientation: "portrait",
        id: "/pocket-pixels/",
        start_url: "/pocket-pixels/",
        scope: "/pocket-pixels/",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Cache everything the game needs, including the font, so it plays offline.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // The link preview image is only for chat apps, not the game.
        globIgnores: ["**/og.png"],
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
  },
}));
