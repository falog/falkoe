import { Upload, Button } from "antd";
import { UploadOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

type AudioUploadProps = {
  onUpload: (file: File) => void;
};

const AudioUpload = ({ onUpload }: AudioUploadProps) => {
  const { t } = useTranslation();

  return (
    <Upload
      accept="audio/*"
      showUploadList={false}
      beforeUpload={(file) => {
        onUpload(file);
        return false; // 自動アップロードしない
      }}
    >
      <Button icon={<UploadOutlined />}>
        {t("components.audioUpload.selectFile")}
      </Button>
    </Upload>
  );
};

export default AudioUpload;
