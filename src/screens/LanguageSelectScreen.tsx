import { Button, Card, Select, Space, Typography } from "antd";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n, setStoredUiLanguage, type UiLanguage } from "../i18n";

type Props = {
  onDone: () => void;
};

export default function LanguageSelectScreen({ onDone }: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState<UiLanguage>("en");

  const options = useMemo(
    () => [
      { value: "en" as const, label: t("app.language.english") },
      { value: "ja" as const, label: t("app.language.japanese") },
    ],
    [t]
  );

  const apply = async () => {
    setStoredUiLanguage(value);
    await i18n.changeLanguage(value);
    onDone();
  };

  return (
    <Space
      orientation="vertical"
      style={{ width: "100%", padding: 16, maxWidth: 560, margin: "0 auto" }}
      size="large"
    >
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t("app.language.title")}
      </Typography.Title>

      <Typography.Text type="secondary">
        {t("app.language.description")}
      </Typography.Text>

      <Card>
        <Select
          style={{ width: 240, maxWidth: "100%" }}
          options={options}
          value={value}
          onChange={(v) => setValue(v as UiLanguage)}
        />
      </Card>

      <Button type="primary" onClick={() => void apply()}>
        {t("app.language.continue")}
      </Button>
    </Space>
  );
}
