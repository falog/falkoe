export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function guessAudioMimeFromPath(path: string): string {
  if (/\.mp3$/i.test(path)) return "audio/mpeg";
  if (/\.wav$/i.test(path)) return "audio/wav";
  if (/\.ogg$/i.test(path)) return "audio/ogg";
  if (/\.m4a$/i.test(path)) return "audio/mp4";
  return "audio/wav";
}

export function guessExtFromPath(path: string): string {
  const m = path.match(/\.([a-z0-9]+)$/i);
  return m ? m[1] : "wav";
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
