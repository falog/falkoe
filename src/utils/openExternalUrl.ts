import { message } from "antd";
import { openUrl } from "@tauri-apps/plugin-opener";
import { i18n } from "../i18n";

export async function openExternalUrl(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (e) {
    console.error("openExternalUrl failed", e);
    message.error(i18n.t("utils.openExternalUrlFailed"));
  }
}
