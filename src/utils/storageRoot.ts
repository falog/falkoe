import { appDataDir, documentDir } from "@tauri-apps/api/path";
import { isMobileRuntime } from "./runtimePlatform";

export async function getFalkoeStorageRootDir(): Promise<string> {
  // Must match Rust: app_data_dir on mobile, document_dir on desktop.
  return isMobileRuntime() ? await appDataDir() : await documentDir();
}
