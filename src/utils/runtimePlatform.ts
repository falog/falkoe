export function isAndroidRuntime(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  const platform = String((navigator as any).platform ?? "");
  return /Android/i.test(ua) || /Android/i.test(platform);
}

export function isIOSRuntime(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  const platform = String((navigator as any).platform ?? "");
  return /iPhone|iPad|iPod/i.test(ua) || /iPhone|iPad|iPod/i.test(platform);
}

export function isMobileRuntime(): boolean {
  return isAndroidRuntime() || isIOSRuntime();
}
