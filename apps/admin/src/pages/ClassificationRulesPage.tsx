import {
  Alert,
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
  message,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { getApiErrorMessage } from "../utils/api-errors";
import { FOUNDATION_COMPONENT_CATEGORIES } from "../utils/discovery-types";

type ClassificationRule = {
  id: string;
  product: string;
  display_name: string;
  category: string;
  patterns: string[];
  source_kind: "builtin" | "user";
  enabled: boolean;
};

type RuleFormValues = {
  product: string;
  display_name: string;
  category: string;
  patterns: string;
  enabled: boolean;
};

export function ClassificationRulesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ClassificationRule | null>(null);
  const [form] = Form.useForm<RuleFormValues>();

  const { data, isLoading } = useQuery({
    queryKey: ["classification-rules"],
    queryFn: () =>
      api<{ items: ClassificationRule[]; total: number }>("/api/monitoring/classification-rules"),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["classification-rules"] });
  };

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/api/monitoring/classification-rules", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      message.success(t("monitoring.classificationRules.saved"));
      setOpen(false);
      form.resetFields();
      invalidate();
    },
    onError: (error) => message.error(getApiErrorMessage(error, t)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/api/monitoring/classification-rules/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      message.success(t("monitoring.classificationRules.saved"));
      setOpen(false);
      setEditing(null);
      form.resetFields();
      invalidate();
    },
    onError: (error) => message.error(getApiErrorMessage(error, t)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api(`/api/monitoring/classification-rules/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      message.success(t("monitoring.classificationRules.deleted"));
      invalidate();
    },
    onError: (error) => message.error(getApiErrorMessage(error, t)),
  });

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({
      product: "",
      display_name: "",
      category: "system_service",
      patterns: "",
      enabled: true,
    });
    setOpen(true);
  };

  const openEdit = (rule: ClassificationRule) => {
    setEditing(rule);
    form.setFieldsValue({
      product: rule.product,
      display_name: rule.display_name,
      category: rule.category,
      patterns: rule.patterns.join(", "),
      enabled: rule.enabled,
    });
    setOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const patterns = values.patterns
      .split(/[,;\n]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    const body = {
      product: values.product.trim(),
      display_name: values.display_name.trim(),
      category: values.category,
      patterns,
      enabled: values.enabled,
    };
    if (editing) {
      await updateMutation.mutateAsync({
        id: editing.id,
        body: {
          display_name: body.display_name,
          category: body.category,
          patterns: body.patterns,
          enabled: body.enabled,
        },
      });
      return;
    }
    await createMutation.mutateAsync(body);
  };

  const categoryOptions = FOUNDATION_COMPONENT_CATEGORIES.map((value) => ({
    value,
    label: t(
      `servers.discovery.categories.${
        value === "message_queue"
          ? "mq"
          : value === "system_service"
            ? "system"
            : value === "deployment_platform"
              ? "deploymentPlatform"
              : value
      }`,
    ),
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t("monitoring.classificationRules.title")}
      </Typography.Title>
      <Alert type="info" showIcon message={t("monitoring.classificationRules.hint")} />
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t("monitoring.classificationRules.add")}
        </Button>
      </div>
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={data?.items ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: t("monitoring.classificationRules.product"), dataIndex: "product", width: 140 },
          { title: t("monitoring.classificationRules.displayName"), dataIndex: "display_name" },
          {
            title: t("monitoring.classificationRules.category"),
            dataIndex: "category",
            width: 140,
            render: (value: string) =>
              t(
                `servers.discovery.categories.${
                  value === "message_queue"
                    ? "mq"
                    : value === "system_service"
                      ? "system"
                      : value === "deployment_platform"
                        ? "deploymentPlatform"
                        : value
                }`,
              ),
          },
          {
            title: t("monitoring.classificationRules.patterns"),
            dataIndex: "patterns",
            render: (patterns: string[]) => (
              <Space size={[4, 4]} wrap>
                {patterns.map((p) => (
                  <Tag key={p}>{p}</Tag>
                ))}
              </Space>
            ),
          },
          {
            title: t("monitoring.classificationRules.source"),
            dataIndex: "source_kind",
            width: 100,
            render: (value: string) => (
              <Tag color={value === "builtin" ? "blue" : "green"}>
                {t(`monitoring.classificationRules.sourceKind.${value}`)}
              </Tag>
            ),
          },
          {
            title: t("monitoring.classificationRules.enabled"),
            dataIndex: "enabled",
            width: 90,
            render: (enabled: boolean) => (
              <Tag color={enabled ? "success" : "default"}>
                {enabled
                  ? t("monitoring.classificationRules.enabledOn")
                  : t("monitoring.classificationRules.enabledOff")}
              </Tag>
            ),
          },
          {
            title: t("common.actions"),
            key: "actions",
            width: 160,
            render: (_: unknown, row: ClassificationRule) => (
              <Space>
                <Button type="link" size="small" onClick={() => openEdit(row)}>
                  {t("common.edit")}
                </Button>
                {row.source_kind === "user" ? (
                  <Button
                    type="link"
                    size="small"
                    danger
                    loading={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(row.id)}
                  >
                    {t("common.delete")}
                  </Button>
                ) : null}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={
          editing
            ? t("monitoring.classificationRules.editTitle")
            : t("monitoring.classificationRules.createTitle")
        }
        open={open}
        onCancel={() => {
          setOpen(false);
          setEditing(null);
        }}
        onOk={() => void submit()}
        confirmLoading={createMutation.isPending || updateMutation.isPending}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="product"
            label={t("monitoring.classificationRules.product")}
            rules={[{ required: true }]}
          >
            <Input disabled={Boolean(editing)} placeholder="prometheus" />
          </Form.Item>
          <Form.Item
            name="display_name"
            label={t("monitoring.classificationRules.displayName")}
            rules={[{ required: true }]}
          >
            <Input placeholder="Prometheus" />
          </Form.Item>
          <Form.Item
            name="category"
            label={t("monitoring.classificationRules.category")}
            rules={[{ required: true }]}
          >
            <Select options={categoryOptions} />
          </Form.Item>
          <Form.Item
            name="patterns"
            label={t("monitoring.classificationRules.patterns")}
            extra={t("monitoring.classificationRules.patternsHint")}
            rules={[{ required: true }]}
          >
            <Input.TextArea rows={3} placeholder="prometheus, prom" />
          </Form.Item>
          <Form.Item name="enabled" label={t("monitoring.classificationRules.enabled")} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}