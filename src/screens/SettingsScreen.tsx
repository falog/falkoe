import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Select, Space, Typography, message, Progress } from "antd";
import TopNav from "../components/TopNav";
import { useModelStatus } from "./recorder/useModelStatus";
import { useTranslation } from "react-i18next";
import {
  getStoredUiLanguage,
  setStoredUiLanguage,
  type UiLanguage,
} from "../i18n";

type ModelVariant =
  | "tiny"
  | "tiny-q8_0"
  | "tiny-q5_1"
  | "base"
  | "base-q8_0"
  | "base-q5_1"
  | "small"
  | "small-q8_0"
  | "small-q5_1"
  | "medium"
  | "medium-q8_0"
  | "medium-q5_0"
  | "large-v3"
  | "large-v3-q5_0"
  | "large-v3-turbo"
  | "large-v3-turbo-q5_0"
  | "large-v3-turbo-q8_0";

type Props = {
  onBack: () => void;
  onOpenIpaList: () => void;
  onOpenHistory: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
  onOpenSettings: () => void;
};

export default function SettingsScreen({
  onBack,
  onOpenIpaList,
  onOpenHistory,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
  onOpenSettings,
}: Props) {
  const { t, i18n } = useTranslation();
  const { status, progress } = useModelStatus();
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(() => {
    const stored = getStoredUiLanguage();
    if (stored) return stored;
    return i18n.resolvedLanguage === "ja" ? "ja" : "en";
  });
  const [variant, setVariant] = useState<ModelVariant>("small");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    invoke<string>("get_model_variant")
      .then((v) => {
        if (cancelled) return;
        const vv = (v || "").trim() as ModelVariant;
        if (
          vv === "tiny" ||
          vv === "tiny-q8_0" ||
          vv === "tiny-q5_1" ||
          vv === "base" ||
          vv === "base-q8_0" ||
          vv === "base-q5_1" ||
          vv === "small" ||
          vv === "small-q8_0" ||
          vv === "small-q5_1" ||
          vv === "medium" ||
          vv === "medium-q8_0" ||
          vv === "medium-q5_0" ||
          vv === "large-v3" ||
          vv === "large-v3-q5_0" ||
          vv === "large-v3-turbo" ||
          vv === "large-v3-turbo-q5_0" ||
          vv === "large-v3-turbo-q8_0"
        ) {
          setVariant(vv);
        }
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(
    () => [
      { value: "tiny-q8_0", label: "tiny-q8_0 (最速 / 精度低め)" },
      { value: "tiny-q5_1", label: "tiny-q5_1 (最速 / 精度低め)" },
      { value: "tiny", label: "tiny (速い / 精度低め)" },
      { value: "base-q8_0", label: "base-q8_0 (速い / 中間)" },
      { value: "base-q5_1", label: "base-q5_1 (速い / 中間)" },
      { value: "base", label: "base (中間)" },
      { value: "small-q8_0", label: "small-q8_0 (やや速い / 高め)" },
      { value: "small-q5_1", label: "small-q5_1 (やや速い / 高め)" },
      { value: "small", label: "small (従来 / 精度高め)" },
      { value: "medium-q8_0", label: "medium-q8_0 (重い / さらに高め)" },
      { value: "medium-q5_0", label: "medium-q5_0 (重い / さらに高め)" },
      { value: "medium", label: "medium (重い / さらに高め)" },
      { value: "large-v3-q5_0", label: "large-v3-q5_0 (最重 / 最高)" },
      { value: "large-v3", label: "large-v3 (最重 / 最高)" },
      {
        value: "large-v3-turbo-q8_0",
        label: "large-v3-turbo-q8_0 (重い / 高速)",
      },
      {
        value: "large-v3-turbo-q5_0",
        label: "large-v3-turbo-q5_0 (重い / 高速)",
      },
      { value: "large-v3-turbo", label: "large-v3-turbo (重い / 高速)" },
    ],
    []
  );

  const uiLanguageOptions = useMemo(
    () => [
      { value: "en" as const, label: t("app.language.english") },
      { value: "ja" as const, label: t("app.language.japanese") },
    ],
    [t]
  );

  const changeUiLanguage = async (next: UiLanguage) => {
    setUiLanguage(next);
    setStoredUiLanguage(next);
    await i18n.changeLanguage(next);
  };

  const apply = async () => {
    try {
      setLoading(true);
      await invoke("set_model_variant", { variant });
      message.success(t("settings.updated"));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
      message.error(t("settings.updateFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <TopNav
        current="settings"
        onBack={onBack}
        onOpenHistory={onOpenHistory}
        onOpenIpaList={onOpenIpaList}
        onOpenDevelopersMistakes={onOpenDevelopersMistakes}
        onOpenCommonMistakes={onOpenCommonMistakes}
        onOpenSettings={onOpenSettings}
      />

      <Typography.Title level={4} style={{ margin: 0 }}>
        {t("settings.title")}
      </Typography.Title>

      <Space orientation="vertical" style={{ width: "100%" }}>
        <Typography.Text>{t("settings.uiLanguage.label")}</Typography.Text>
        <Select
          style={{ width: 360, maxWidth: "100%" }}
          value={uiLanguage}
          options={uiLanguageOptions}
          onChange={(v) => void changeUiLanguage(v as UiLanguage)}
        />
        <Typography.Text type="secondary">
          {t("settings.uiLanguage.note")}
        </Typography.Text>

        <Typography.Text>{t("settings.model.label")}</Typography.Text>
        <Select
          style={{ width: 360, maxWidth: "100%" }}
          value={variant}
          options={options}
          onChange={(v) => setVariant(v as ModelVariant)}
          disabled={loading}
        />

        <Button type="primary" onClick={apply} loading={loading}>
          {t("settings.apply")}
        </Button>

        <Typography.Text type="secondary">
          {t("settings.model.note")}
        </Typography.Text>

        <Space orientation="vertical" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {t("settings.model.status", { status })}
          </Typography.Text>
          {status === "downloading" && typeof progress === "number" && (
            <Progress percent={progress} size="small" />
          )}
        </Space>
      </Space>
    </Space>
  );
}
