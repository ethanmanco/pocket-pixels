import { defineConfig } from "vitest/config";

// GitHub Pages serves the site from /pocket-pixels/, local dev serves from /.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/pocket-pixels/" : "/",
  test: {
    include: ["tests/**/*.test.ts"],
  },
}));
