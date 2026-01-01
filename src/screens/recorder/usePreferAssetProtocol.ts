import { useMemo } from "react";

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

  return !isLinux;
}
