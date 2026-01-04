import { Button, Space } from "antd";

export type TopNavCurrent =
  | "word"
  | "record"
  | "history"
  | "ipa"
  | "mistakes"
  | "common";

type Props = {
  current: TopNavCurrent;
  onBack?: () => void;
  onOpenHistory?: () => void;
  onOpenIpaList: () => void;
  onOpenDevelopersMistakes: () => void;
  onOpenCommonMistakes: () => void;
};

export default function TopNav({
  current,
  onBack,
  onOpenHistory,
  onOpenIpaList,
  onOpenDevelopersMistakes,
  onOpenCommonMistakes,
}: Props) {
  return (
    <Space wrap>
      {onBack && <Button onClick={onBack}>← 戻る</Button>}

      {onOpenHistory && (
        <Button disabled={current === "history"} onClick={onOpenHistory}>
          録音履歴
        </Button>
      )}

      <Button disabled={current === "ipa"} onClick={onOpenIpaList}>
        IPA 発音一覧
      </Button>
      <Button
        disabled={current === "mistakes"}
        onClick={onOpenDevelopersMistakes}
      >
        Developer’s mistakes
      </Button>
      <Button disabled={current === "common"} onClick={onOpenCommonMistakes}>
        よくある間違い
      </Button>
    </Space>
  );
}
