import { message } from "antd";
import { useEffect, useState } from "react";
import { loadIpaIndex, type IpaIndex } from "../../utils/ipaResources";

export function useIpaIndex(): IpaIndex | null {
  const [ipaIndex, setIpaIndex] = useState<IpaIndex | null>(null);

  useEffect(() => {
    loadIpaIndex()
      .then((idx) => {
        setIpaIndex(idx);
      })
      .catch((e) => {
        setIpaIndex(null);
        const msg = String((e as any)?.message ?? e);
        message.error(`IPA index 読み込み失敗: ${msg}`);
      });
  }, []);

  return ipaIndex;
}
