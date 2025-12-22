import { Upload, Button } from "antd";
import { UploadOutlined } from "@ant-design/icons";

type AudioUploadProps = {
  onUpload: (file: File) => void;
};

const AudioUpload = ({ onUpload }: AudioUploadProps) => {
  return (
    <Upload
      accept="audio/*"
      showUploadList={false}
      beforeUpload={(file) => {
        onUpload(file);
        return false; // 自動アップロードしない
      }}
    >
      <Button icon={<UploadOutlined />}>音声ファイルを選択</Button>
    </Upload>
  );
};

export default AudioUpload;
