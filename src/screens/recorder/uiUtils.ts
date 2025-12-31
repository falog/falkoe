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
