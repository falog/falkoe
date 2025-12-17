import { Button, List, Typography } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";

export type Sentence = {
  id: number;
  text: string;
  audioUrl: string;
};

type ExampleListProps = {
  sentences: Sentence[];
  onSelect: (sentence: Sentence) => void;
};

const ExampleList = ({ sentences, onSelect }: ExampleListProps) => {
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
              onClick={() => playAudio(item.audioUrl)}
            />,
            <Button
              key="select"
              type="primary"
              size="small"
              onClick={() => onSelect(item)}
            >
              この例文で録音
            </Button>,
          ]}
        >
          <Typography.Text>{item.text}</Typography.Text>
        </List.Item>
      )}
    />
  );
};

export default ExampleList;
