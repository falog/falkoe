import { message } from "antd";

let sharedAudioEl: HTMLAudioElement | null = null;
let sharedPlayId = 0;

function getSharedAudioEl(): HTMLAudioElement {
  if (!sharedAudioEl) {
    sharedAudioEl = new Audio();
    sharedAudioEl.preload = "auto";
    sharedAudioEl.autoplay = false;
    sharedAudioEl.muted = false;
    sharedAudioEl.volume = 1;
  }
  return sharedAudioEl;
}

export function confirmOverwriteExisting(): Promise<boolean> {
  return new Promise((resolve) => {
    message.info({
      content: "既に保存済みの音声があります。上書きしますか？（自動でOK）",
      duration: 1,
      onClick: () => resolve(true),
      onClose: () => resolve(false),
    });
    setTimeout(() => resolve(true), 1000);
  });
}

export async function playAudioUrl(url: string | null) {
  if (!url) {
    message.info("音声を読み込み中…");
    return;
  }

  try {
    const playId = ++sharedPlayId;
    const audio = getSharedAudioEl();

    audio.pause();
    audio.currentTime = 0;
    audio.src = url;
    audio.load();

    const played = audio.play();
    await played;

    // Some WebViews can resolve play() but still never start. If this request
    // is still current and we haven't advanced at all, emit a debug hint.
    await new Promise((r) => setTimeout(r, 250));
    if (playId === sharedPlayId && audio.paused && audio.currentTime === 0) {
      console.warn("Audio.play() did not start (paused at 0s)", {
        url,
        error: audio.error,
        readyState: audio.readyState,
        networkState: audio.networkState,
      });
    }
  } catch (e) {
    console.error("Audio playback failed:", e);
    message.error("音声の再生に失敗しました");
  }
}

export async function playAudioUrlUntilEnded(
  url: string | null
): Promise<boolean> {
  if (!url) {
    message.info("音声を読み込み中…");
    return false;
  }

  try {
    const playId = ++sharedPlayId;
    const audio = getSharedAudioEl();

    audio.pause();
    audio.currentTime = 0;
    audio.src = url;
    audio.load();

    await audio.play();

    const ok = await new Promise<boolean>((resolve) => {
      audio.addEventListener("ended", () => resolve(true), { once: true });
      audio.addEventListener("error", () => resolve(false), { once: true });
    });

    if (playId !== sharedPlayId) return false;

    return ok;
  } catch (e) {
    console.error("Audio playback failed:", e);
    message.error("音声の再生に失敗しました");
    return false;
  }
}
