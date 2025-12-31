import { message } from "antd";

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
    const audio = new Audio(url);
    await audio.play();
  } catch (e) {
    console.error("Audio playback failed:", e);
    message.error("音声の再生に失敗しました");
  }
}
