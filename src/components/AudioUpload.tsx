import { Button } from "antd";
import { UploadOutlined } from "@ant-design/icons";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

type AudioUploadProps = {
  onUpload?: (file: File) => void;
  onUploadFiles?: (files: File[]) => void;
  disabled?: boolean;
};

const AudioUpload = ({
  onUpload,
  onUploadFiles,
  disabled,
}: AudioUploadProps) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const accept = useMemo(() => "audio/*", []);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const list = e.currentTarget.files;
          const files = list ? Array.from(list) : [];

          if (files.length > 0) {
            if (onUploadFiles) {
              onUploadFiles(files);
            } else if (onUpload) {
              onUpload(files[0]);
            }
          }

          // 同じファイルを再選択できるようにリセット
          e.currentTarget.value = "";
        }}
      />
      <Button
        icon={<UploadOutlined />}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {t("components.audioUpload.selectFile")}
      </Button>
    </>
  );
};

export default AudioUpload;
