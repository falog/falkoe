import { message } from "antd";
import { useEffect, useState } from "react";
import { loadIpaIndex, type IpaIndex } from "../../utils/ipaResources";
import { useTranslation } from "react-i18next";

export function useIpaIndex(): IpaIndex | null {
  const { t } = useTranslation();
  const [ipaIndex, setIpaIndex] = useState<IpaIndex | null>(null);

  useEffect(() => {
    loadIpaIndex()
      .then((idx) => {
        setIpaIndex(idx);
      })
      .catch((e) => {
        setIpaIndex(null);
        const msg = String((e as any)?.message ?? e);
        message.error(`${t("screens.recorder.ipaIndexLoadFailed")}${msg}`);
      });
  }, [t]);

  return ipaIndex;
}
