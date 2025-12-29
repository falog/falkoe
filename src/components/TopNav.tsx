import { Button, Space } from "antd";

export type TopNavCurrent = "word" | "record" | "ipa" | "mistake" | "common";

type Props = {
  current: TopNavCurrent;
  onBack?: () => void;
  onOpenIpaList: () => void;
  onOpenDevelopersMistake: () => void;
  onOpenCommonMistakes: () => void;
};

export default function TopNav({
  current,
  onBack,
  onOpenIpaList,
  onOpenDevelopersMistake,
  onOpenCommonMistakes,
}: Props) {
  return (
    <Space wrap>
      {onBack && <Button onClick={onBack}>← 戻る</Button>}

      <Button disabled={current === "ipa"} onClick={onOpenIpaList}>
        IPA 発音一覧
      </Button>
      <Button
        disabled={current === "mistake"}
        onClick={onOpenDevelopersMistake}
      >
        Developer’s mistake
      </Button>
      <Button disabled={current === "common"} onClick={onOpenCommonMistakes}>
        よくある間違い
      </Button>
    </Space>
  );
}
