import { stat } from "@tauri-apps/plugin-fs";
import { isAndroidRuntime } from "./runtimePlatform";

// Avoid Android WebView OOM by preventing very large files from being loaded
// into JS/Rust IPC as a single byte array.
export const ANDROID_MAX_IPC_BYTES_DEFAULT = 32 * 1024 * 1024; // 32 MiB

export async function guardAndroidIpcFileSize(
  path: string,
  opts?: { label?: string; limitBytes?: number }
): Promise<void> {
  if (!isAndroidRuntime()) return;

  const label = opts?.label ?? "file";
  const limitBytes = opts?.limitBytes ?? ANDROID_MAX_IPC_BYTES_DEFAULT;

  try {
    const info = await stat(path);
    const size = (info as any)?.size;
    if (typeof size === "number" && size > limitBytes) {
      throw new Error(
        `${label} is too large to load on Android (${size} bytes > ${limitBytes} bytes): ${path}`
      );
    }
  } catch (e) {
    // If stat fails (e.g. virtual paths), we allow the caller to try readFile().
    // But if we threw due to size, propagate.
    if (e instanceof Error && e.message.includes("too large to load on Android")) {
      throw e;
    }
  }
}
