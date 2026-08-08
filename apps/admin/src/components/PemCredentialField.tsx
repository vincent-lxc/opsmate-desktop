import { ProFormTextArea } from "@ant-design/pro-components";
import { Button, Form, Typography, Upload, message } from "antd";
import { UploadOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";

type PemCredentialFieldProps = {
  name: string;
  label: string;
  placeholder?: string;
};

const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;

function isLikelyPublicKey(text: string, fileName: string): boolean {
  if (fileName.endsWith(".pub")) return true;
  if (/-----BEGIN PUBLIC KEY-----/.test(text)) return true;
  return /^(ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-)/.test(text.trim());
}

function isLikelyPrivateKey(text: string): boolean {
  return PRIVATE_KEY_PATTERN.test(text);
}

export function PemCredentialField({
  name,
  label,
  placeholder,
}: PemCredentialFieldProps) {
  const { t } = useTranslation();
  const form = Form.useFormInstance();

  return (
    <>
      <ProFormTextArea
        name={name}
        label={label}
        placeholder={placeholder}
        fieldProps={{
          rows: 5,
          style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 },
        }}
      />
      <Form.Item label=" " colon={false}>
        <Upload
          showUploadList={false}
          beforeUpload={(file) => {
            const reader = new FileReader();
            reader.onload = () => {
              const text = typeof reader.result === "string" ? reader.result.trim() : "";
              if (!text) {
                message.error(t("servers.form.uploadEmpty"));
                return;
              }
              if (isLikelyPublicKey(text, file.name)) {
                message.error(t("servers.form.uploadPublicKey"));
                return;
              }
              if (!isLikelyPrivateKey(text)) {
                message.error(t("servers.form.uploadInvalidKey"));
                return;
              }
              form.setFieldValue(name, text);
              message.success(t("servers.form.uploadSuccess", { file: file.name }));
            };
            reader.onerror = () => {
              message.error(t("servers.form.uploadFailed"));
            };
            reader.readAsText(file);
            return false;
          }}
        >
          <Button icon={<UploadOutlined />}>{t("servers.form.uploadPem")}</Button>
        </Upload>
        <Typography.Text type="secondary" style={{ display: "block", marginTop: 8, fontSize: 12 }}>
          {t("servers.form.uploadPemHint")}
        </Typography.Text>
      </Form.Item>
    </>
  );
}