import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Run by `tauri dev` and `tauri build` (see src-tauri/tauri.conf.json).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // The editor package is linked from ../../packages/editor.
    fs: { allow: ["..", "../../packages/editor"] },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // The linked editor package has its own React for its tests; use one copy.
  resolve: { dedupe: ["react", "react-dom"] },
  // One bundle loaded from disk; splitting it would only add requests.
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
