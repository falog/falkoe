import { Button, Space } from "antd";
import { useTranslation } from "react-i18next";

export type TopNavCurrent =
  | "word"
  | "record"
  | "history"
  | "cutter"
  | "ipa"
  | "mistakes"
  | "common"
  | "settings";

type Props = {
  current: TopNavCurrent;
  onBack?: () => void;
  onOpenHistory?: () => void;
  onOpenAudioCutter?: () => void;
  onOpenIpaList: () => void;
  onOpenSettings: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
};

export default function TopNav({
  current,
  onBack,
  onOpenHistory,
  onOpenAudioCutter,
  onOpenIpaList,
  onOpenSettings,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
}: Props) {
  const { t } = useTranslation();

  return (
    <Space wrap>
      {onBack && <Button onClick={onBack}>{t("nav.back")}</Button>}

      {onOpenHistory && (
        <Button disabled={current === "history"} onClick={onOpenHistory}>
          {t("nav.history")}
        </Button>
      )}

      {onOpenAudioCutter && (
        <Button disabled={current === "cutter"} onClick={onOpenAudioCutter}>
          {t("nav.audioCutter")}
        </Button>
      )}

      <Button disabled={current === "ipa"} onClick={onOpenIpaList}>
        {t("nav.ipaList")}
      </Button>
      <Button
        disabled={current === "mistakes"}
        onClick={onOpenDevelopersMistakes}
      >
        {t("nav.developersMistakes")}
      </Button>
      <Button disabled={current === "common"} onClick={onOpenCommonMistakes}>
        {t("nav.commonMistakes")}
      </Button>

      <Button disabled={current === "settings"} onClick={onOpenSettings}>
        {t("nav.settings")}
      </Button>
    </Space>
  );
}
