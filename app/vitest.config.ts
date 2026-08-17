// Standalone from vite.config.ts on purpose — that file is a managed wrapper
// (@lovable.dev/vite-tanstack-config) that warns against adding plugins
// directly, and unit tests need none of what it configures (TanStack Start,
// Nitro, the dev server). This file only needs to resolve the app's "@/*"
// alias so pure-logic modules under src/lib can be imported the same way
// the app itself imports them.
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
