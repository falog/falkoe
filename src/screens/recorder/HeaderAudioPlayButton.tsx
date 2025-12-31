import { Button } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { playAudioUrl } from "./uiUtils";

type Props = {
  url: string | null;
  loading: boolean;
  disabled: boolean;
};

export default function HeaderAudioPlayButton({
  url,
  loading,
  disabled,
}: Props) {
  return (
    <Button
      type="text"
      icon={<PlayCircleOutlined />}
      disabled={disabled}
      loading={loading}
      onClick={async () => {
        await playAudioUrl(url);
      }}
      style={{ opacity: 0.7 }}
      onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
      onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
    />
  );
}
