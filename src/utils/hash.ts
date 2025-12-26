/**
 * SHA256ハッシュ値を生成 (text + lang の組み合わせから)
 */
export async function sha256(text: string, lang: string): Promise<string> {
  const combined = `${text}:${lang}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(combined);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  // ArrayBufferを16進数文字列に変換
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return hashHex;
}

/**
 * SHA256ハッシュ値を生成 (bytes + lang の組み合わせから)
 * - 音声認識モードなど text が空になるケースでのID衝突回避用
 */
export async function sha256Bytes(
  bytes: Uint8Array,
  lang: string
): Promise<string> {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`lang:${lang}\n`);

  const combined = new Uint8Array(prefix.length + bytes.length);
  combined.set(prefix, 0);
  combined.set(bytes, prefix.length);

  const hashBuffer = await crypto.subtle.digest("SHA-256", combined);

  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return hashHex;
}
