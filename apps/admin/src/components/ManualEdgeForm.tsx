import { Form, Input, Modal, Select } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { MonitorTarget, TopologyEdge } from "../utils/discovery-types";

type ManualEdgeFormProps = {
  open: boolean;
  serverId: string;
  sourceTargetId?: string;
  onClose: () => void;
  onSubmit: (values: {
    source_target_id: string;
    target_target_id?: string;
    unresolved_hostname?: string;
    edge_type: TopologyEdge["edge_type"];
    label?: string;
    note?: string;
  }) => Promise<void>;
};

export function ManualEdgeForm({
  open,
  serverId,
  sourceTargetId,
  onClose,
  onSubmit,
}: ManualEdgeFormProps) {
  const { t } = useTranslation();
  const [form] = Form.useForm();

  const { data: localTargets } = useQuery({
    queryKey: ["server-targets", serverId],
    queryFn: () =>
      api<{ items: MonitorTarget[] }>(`/api/servers/${serverId}/targets`),
    enabled: open,
  });

  const { data: serversData } = useQuery({
    queryKey: ["servers"],
    queryFn: () => api<{ items: { id: string; name: string }[] }>("/api/servers"),
    enabled: open,
  });

  const { data: remoteTargets } = useQuery({
    queryKey: ["all-targets-for-edges"],
    queryFn: async () => {
      const servers = serversData?.items ?? [];
      const all: Array<MonitorTarget & { server_name: string }> = [];
      for (const s of servers) {
        const res = await api<{ items: MonitorTarget[] }>(`/api/servers/${s.id}/targets`);
        for (const item of res.items) {
          all.push({ ...item, server_name: s.name });
        }
      }
      return all;
    },
    enabled: open && Boolean(serversData?.items?.length),
  });

  const handleFinish = async () => {
    const values = await form.validateFields();
    await onSubmit({
      source_target_id: values.source_target_id,
      target_target_id: values.target_target_id,
      unresolved_hostname: values.unresolved_hostname,
      edge_type: values.edge_type,
      label: values.label,
      note: values.note,
    });
    form.resetFields();
    onClose();
  };

  return (
    <Modal
      open={open}
      title={t("servers.discovery.addDependency")}
      onCancel={onClose}
      onOk={() => void handleFinish()}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ source_target_id: sourceTargetId, edge_type: "dependency" }}
      >
        <Form.Item
          name="source_target_id"
          label={t("servers.discovery.sourceTarget")}
          rules={[{ required: true }]}
        >
          <Select
            options={(localTargets?.items ?? []).map((t) => ({
              value: t.id,
              label: t.name,
            }))}
          />
        </Form.Item>
        <Form.Item name="target_target_id" label={t("servers.discovery.targetTarget")}>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            options={(remoteTargets ?? [])
              .filter((t) => t.server_id !== serverId || t.id !== sourceTargetId)
              .map((t) => ({
                value: t.id,
                label: `${t.server_name} / ${t.name} (${t.category})`,
              }))}
          />
        </Form.Item>
        <Form.Item name="unresolved_hostname" label={t("servers.discovery.pendingHostname")}>
          <Input placeholder="cache.internal.example" />
        </Form.Item>
        <Form.Item name="edge_type" label={t("servers.discovery.edgeType")} rules={[{ required: true }]}>
          <Select
            options={[
              { value: "dependency", label: "dependency" },
              { value: "data_flow", label: "data_flow" },
            ]}
          />
        </Form.Item>
        <Form.Item name="label" label={t("common.name")}>
          <Input />
        </Form.Item>
        <Form.Item name="note" label={t("servers.discovery.note")}>
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}