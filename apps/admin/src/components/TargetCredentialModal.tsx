import { Form, Input, Modal, Typography } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MonitorTarget } from "../utils/discovery-types";
import {
  getCredentialEnvKeys,
  getTargetAppName,
  getTargetCredentials,
  isCredentialFromEnv,
} from "../utils/target-display";

type TargetCredentialModalProps = {
  open: boolean;
  target: MonitorTarget | null;
  onClose: () => void;
  onSubmit: (values: { username?: string; password?: string }) => Promise<void>;
};

export function TargetCredentialModal({
  open,
  target,
  onClose,
  onSubmit,
}: TargetCredentialModalProps) {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const isEdit = target?.credential_status === "configured";
  const fromEnv = isEdit && target ? isCredentialFromEnv(target) : false;
  const envKeys = target ? getCredentialEnvKeys(target) : [];

  useEffect(() => {
    if (open && target) {
      form.setFieldsValue({
        username: getTargetCredentials(target)?.username?.trim() ?? "",
        password: "",
      });
    }
  }, [form, open, target]);

  const handleOk = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await onSubmit(values);
      form.resetFields();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={
        isEdit
          ? t("servers.discovery.editCredentialTitle", {
              name: target ? getTargetAppName(target) : "",
            })
          : t("servers.discovery.addCredentialTitle", {
              name: target ? getTargetAppName(target) : "",
            })
      }
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      onOk={() => void handleOk()}
      confirmLoading={submitting}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        {fromEnv ? (
          <Typography.Text type="secondary" style={{ display: "block", marginBottom: 16 }}>
            {t("servers.discovery.credentialFromEnvHint", { keys: envKeys.join(", ") })}
          </Typography.Text>
        ) : null}
        <Form.Item name="username" label={t("servers.discovery.credentialUsername")}>
          <Input placeholder="redis / postgres / root" />
        </Form.Item>
        <Form.Item
          name="password"
          label={t("servers.discovery.credentialPassword")}
          rules={
            isEdit
              ? []
              : [{ required: true, message: t("servers.discovery.credentialPasswordRequired") }]
          }
          extra={isEdit ? t("servers.discovery.credentialPasswordKeep") : undefined}
        >
          <Input.Password
            autoComplete="new-password"
            placeholder={isEdit ? t("servers.discovery.credentialPasswordKeepPlaceholder") : undefined}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}