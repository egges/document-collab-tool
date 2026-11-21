import { defineConfig } from "vitest/config";

export default defineConfig({
  root: "demo",
  // The demo loads the regression-test pages from ../test/pages.
  server: { fs: { allow: [".."] } },
  test: {
    root: ".",
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
  },
});
