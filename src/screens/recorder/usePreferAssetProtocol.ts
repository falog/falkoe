import { useMemo } from "react";
import { isMobileRuntime } from "../../utils/runtimePlatform";

export function usePreferAssetProtocol(): boolean {
  const isLinux = useMemo(() => {
    const ua =
      typeof navigator !== "undefined" ? (navigator.userAgent ?? "") : "";
    const plat =
      typeof navigator !== "undefined"
        ? ((navigator as any).platform ?? "")
        : "";
    return /Linux/i.test(ua) || /Linux/i.test(String(plat));
  }, []);

  // Mobile WebViews are more reliable with Blob URLs (fs readFile) than with
  // asset protocol URLs for app-internal storage paths.
  if (isMobileRuntime()) return false;

  return !isLinux;
}
