import { invoke } from "@tauri-apps/api/core";
import type { DisplayMode, RenderLinkingResult } from "../types/linking";

export async function renderLinkingRust(
  text: string,
  options?: { linkingMode?: boolean; displayMode?: DisplayMode; useDict?: boolean }
): Promise<RenderLinkingResult> {
  return invoke<RenderLinkingResult>("render_linking", {
    text,
    linkingMode: options?.linkingMode,
    displayMode: options?.displayMode,
    useDict: options?.useDict,
  });
}
