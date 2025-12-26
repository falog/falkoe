import { Button, List, Typography } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";

export type Sentence = {
  id: number;
  text: string;
  audioUrl: string;
  lang: string;
};

type ExampleListProps = {
  sentences: Sentence[];
  onSelect: (sentence: Sentence) => void;
  onRecord?: (s: Sentence) => void;
  disabled?: boolean;
};

const ExampleList = ({ sentences, onSelect, disabled }: ExampleListProps) => {
  const playAudio = (url: string) => {
    const audio = new Audio(url);
    audio.play();
  };

  return (
    <List
      bordered
      dataSource={sentences}
      locale={{ emptyText: "例文が見つかりませんでした" }}
      renderItem={(item) => (
        <List.Item
          actions={[
            <Button
              key="play"
              icon={<PlayCircleOutlined />}
              disabled={disabled}
              onClick={() => playAudio(item.audioUrl)}
            />,
            <Button
              key="select"
              type="primary"
              size="small"
              disabled={disabled}
              onClick={() => onSelect(item)}
            >
              この例文で練習
            </Button>,
          ]}
        >
          <Typography.Text disabled={disabled}>{item.text}</Typography.Text>
        </List.Item>
      )}
    />
  );
};

export default ExampleList;
