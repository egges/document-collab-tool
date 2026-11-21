// The window's entries in the developer log (see src-tauri/src/devlog.rs).
// They go to the Rust side so there is one timeline. Never log page text.
import { type LogLevel, devApi } from "./api.ts";

export function log(level: LogLevel, source: string, message: string) {
  devApi.add(level, source, message).catch(() => {});
}
