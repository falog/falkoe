export function isAndroidRuntime(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  const platform = String((navigator as any).platform ?? "");
  return /Android/i.test(ua) || /Android/i.test(platform);
}
