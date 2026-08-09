import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  platformAiApi,
  type PlatformProvider,
} from "../../../api/platform-ai";

type TestResult = {
  ok: boolean;
  model: string;
  latency_ms: number;
  error?: string;
};

export default function ProvidersPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PlatformProvider | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>(
    {},
  );
  const [testingId, setTestingId] = useState<string | null>(null);
  const [form] = Form.useForm();

  const { data, isLoading } = useQuery({
    queryKey: ["platform-ai-providers"],
    queryFn: () => platformAiApi.listProviders(),
  });

  const saveMutation = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      if (editing) {
        return platformAiApi.updateProvider(editing.id, values);
      }
      return platformAiApi.createProvider(values);
    },
    onSuccess: () => {
      message.success(t("common.saved"));
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ["platform-ai-providers"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => platformAiApi.deleteProvider(id),
    onSuccess: () => {
      message.success(t("common.deleted"));
      void qc.invalidateQueries({ queryKey: ["platform-ai-providers"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const onTest = async (id: string) => {
    setTestingId(id);
    try {
      const res = await platformAiApi.testProvider(id);
      setTestResults((prev) => ({ ...prev, [id]: res }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [id]: {
          ok: false,
          model: "",
          latency_ms: 0,
          error: e instanceof Error ? e.message : t("common.failed"),
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      provider: "openai",
      api_base: "https://api.openai.com/v1",
      is_enabled: true,
    });
    setModalOpen(true);
  };

  const openEdit = (row: PlatformProvider) => {
    setEditing(row);
    form.setFieldsValue({
      name: row.name,
      provider: row.provider,
      api_base: row.api_base,
      model: row.model,
      is_enabled: row.is_enabled,
      api_key: "",
    });
    setModalOpen(true);
  };

  return (
    <div>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t("aiProviders.title")}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t("aiProviders.subtitle")}
          </Typography.Paragraph>
        </div>
        <Button type="primary" onClick={openCreate}>
          {t("aiProviders.create")}
        </Button>
      </Space>

      <Table<PlatformProvider>
        rowKey="id"
        loading={isLoading}
        dataSource={data?.items ?? []}
        columns={[
          { title: t("aiProviders.colName"), dataIndex: "name" },
          { title: t("aiProviders.colType"), dataIndex: "provider", width: 100 },
          { title: t("aiProviders.colModel"), dataIndex: "model", ellipsis: true },
          {
            title: t("aiProviders.colKey"),
            width: 90,
            render: (_, r) =>
              r.api_key_configured ? (
                <Tag color="green">{t("aiProviders.keySet")}</Tag>
              ) : (
                <Tag>{t("aiProviders.keyEmpty")}</Tag>
              ),
          },
          {
            title: t("aiProviders.colEnabled"),
            width: 90,
            render: (_, r) =>
              r.is_enabled ? (
                <Tag color="blue">{t("common.on")}</Tag>
              ) : (
                <Tag>{t("common.off")}</Tag>
              ),
          },
          {
            title: t("aiProviders.colTest"),
            width: 240,
            render: (_, r) => {
              const tr = testResults[r.id];
              return (
                <Space direction="vertical" size={4}>
                  <Button
                    size="small"
                    loading={testingId === r.id}
                    onClick={() => void onTest(r.id)}
                  >
                    {t("common.test")}
                  </Button>
                  {tr && (
                    <Tag color={tr.ok ? "success" : "error"}>
                      {tr.ok
                        ? t("aiProviders.testOk", {
                            model: tr.model,
                            ms: tr.latency_ms,
                          })
                        : t("aiProviders.testFailed", {
                            error: tr.error ?? t("common.failed"),
                          })}
                    </Tag>
                  )}
                </Space>
              );
            },
          },
          {
            title: t("aiProviders.colActions"),
            width: 160,
            render: (_, r) => (
              <Space>
                <Button size="small" onClick={() => openEdit(r)}>
                  {t("common.edit")}
                </Button>
                <Button
                  size="small"
                  danger
                  onClick={() => deleteMutation.mutate(r.id)}
                >
                  {t("common.delete")}
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? t("aiProviders.editTitle") : t("aiProviders.createTitle")}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={saveMutation.isPending}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => {
            const body = { ...values } as Record<string, unknown>;
            if (!body.api_key) delete body.api_key;
            saveMutation.mutate(body);
          }}
        >
          <Form.Item name="name" label={t("aiProviders.fieldName")} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="provider" label={t("aiProviders.fieldProvider")} rules={[{ required: true }]}>
            <Select
              options={[
                { value: "openai", label: "OpenAI" },
                { value: "ollama", label: "Ollama" },
                { value: "custom", label: t("aiConfig.providerCustom", { defaultValue: "Custom" }) },
              ]}
            />
          </Form.Item>
          <Form.Item name="api_base" label={t("aiProviders.fieldApiBase")} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="model" label={t("aiProviders.fieldModel")} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="api_key"
            label={editing ? t("aiProviders.fieldApiKeyKeep") : t("aiProviders.fieldApiKey")}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item name="is_enabled" label={t("aiProviders.fieldEnabled")} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
