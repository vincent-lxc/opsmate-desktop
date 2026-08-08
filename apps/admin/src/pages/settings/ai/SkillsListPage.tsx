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
  Upload,
} from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { platformAiApi, type AgentKind, type PlatformSkill } from "../../../api/platform-ai";

function buildSkillMd(input: {
  name: string;
  description: string;
  compatible_kinds: AgentKind[];
  body: string;
}): string {
  const name = input.name.trim();
  const description = input.description.trim() || name;
  const kinds = input.compatible_kinds.length
    ? input.compatible_kinds
    : (["ops"] as AgentKind[]);
  const kindsYaml = `[${kinds.join(", ")}]`;
  const body =
    input.body.trim() ||
    [
      `# ${name}`,
      "",
      description,
      "",
      "Write instructions for the agent here. Use clear sections and JSON output contracts when needed.",
    ].join("\n");
  return `---
name: ${JSON.stringify(name).slice(1, -1)}
description: ${JSON.stringify(description).slice(1, -1)}
compatible_kinds: ${kindsYaml}
version: 1
permissions: []
---

${body}
`;
}

async function filesFromUpload(file: File): Promise<Record<string, string>> {
  if (file.name.endsWith(".md") || file.name === "SKILL.md") {
    const text = await file.text();
    return { "SKILL.md": text };
  }
  const text = await file.text();
  try {
    const parsed = JSON.parse(text) as { files?: Record<string, string> };
    if (parsed.files) return parsed.files;
  } catch {
    /* treat as body */
  }
  return {
    "SKILL.md": `---
name: uploaded-skill
description: Uploaded skill package
compatible_kinds: [ops]
version: 1
permissions: []
---

${text}
`,
  };
}

type CreateForm = {
  name: string;
  description: string;
  compatible_kinds: AgentKind[];
  body: string;
};

export default function SkillsListPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm<CreateForm>();

  const { data, isLoading } = useQuery({
    queryKey: ["platform-ai-skills"],
    queryFn: () => platformAiApi.listSkills(),
  });

  const createMutation = useMutation({
    mutationFn: (values: CreateForm) => {
      const files = {
        "SKILL.md": buildSkillMd({
          name: values.name,
          description: values.description ?? "",
          compatible_kinds: values.compatible_kinds ?? ["ops"],
          body: values.body ?? "",
        }),
      };
      return platformAiApi.uploadSkill(files);
    },
    onSuccess: (skill) => {
      message.success(
        t("aiSkills.created"),
      );
      setCreateOpen(false);
      createForm.resetFields();
      void qc.invalidateQueries({ queryKey: ["platform-ai-skills"] });
      navigate(`/settings/ai/skills/${skill.id}`);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const uploadMutation = useMutation({
    mutationFn: (files: Record<string, string>) =>
      platformAiApi.uploadSkill(files),
    onSuccess: (skill) => {
      message.success(t("aiSkills.uploaded"));
      void qc.invalidateQueries({ queryKey: ["platform-ai-skills"] });
      navigate(`/settings/ai/skills/${skill.id}`);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, is_enabled }: { id: string; is_enabled: boolean }) =>
      platformAiApi.patchSkillMeta(id, { is_enabled }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["platform-ai-skills"] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <div>
      <Space
        style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }}
      >
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t("aiSkills.title")}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t("aiSkills.subtitle")}
          </Typography.Paragraph>
        </div>
        <Space>
          <Upload
            accept=".md,.json"
            showUploadList={false}
            beforeUpload={(file) => {
              void filesFromUpload(file).then((files) =>
                uploadMutation.mutate(files),
              );
              return false;
            }}
          >
            <Button loading={uploadMutation.isPending}>
              {t("aiSkills.upload")}
            </Button>
          </Upload>
          <Button
            type="primary"
            onClick={() => {
              createForm.setFieldsValue({
                name: "",
                description: "",
                compatible_kinds: ["ops"],
                body: "",
              });
              setCreateOpen(true);
            }}
          >
            {t("aiSkills.create")}
          </Button>
        </Space>
      </Space>

      <Table<PlatformSkill>
        rowKey="id"
        loading={isLoading}
        dataSource={data?.items ?? []}
        columns={[
          { title: t("aiSkills.colName"), dataIndex: "name" },
          {
            title: t("aiSkills.colSlug"),
            dataIndex: "slug",
            width: 160,
          },
          {
            title: t("aiSkills.colKinds"),
            dataIndex: "compatible_kinds",
            render: (kinds: string[]) =>
              (kinds ?? []).map((k) => (
                <Tag key={k}>{k}</Tag>
              )),
          },
          {
            title: t("aiSkills.colScripts"),
            width: 90,
            render: (_, r) =>
              r.has_scripts ? <Tag color="purple">yes</Tag> : <Tag>no</Tag>,
          },
          {
            title: t("aiSkills.colSource"),
            dataIndex: "source",
            width: 100,
            render: (s: string) => <Tag>{s}</Tag>,
          },
          {
            title: t("aiSkills.colVer"),
            dataIndex: "version",
            width: 60,
          },
          {
            title: t("aiSkills.colEnabled"),
            width: 90,
            render: (_, r) => (
              <Switch
                checked={r.is_enabled}
                onChange={(is_enabled) =>
                  toggleMutation.mutate({ id: r.id, is_enabled })
                }
              />
            ),
          },
          {
            title: t("aiSkills.colActions"),
            width: 100,
            render: (_, r) => (
              <Button
                type="link"
                onClick={() => navigate(`/settings/ai/skills/${r.id}`)}
              >
                {t("aiSkills.edit")}
              </Button>
            ),
          },
        ]}
      />

      <Modal
        title={t("aiSkills.createTitle")}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        okText={t("aiSkills.createSubmit")}
        confirmLoading={createMutation.isPending}
        width={720}
        destroyOnClose
        onOk={() => {
          void createForm.validateFields().then((values) => {
            createMutation.mutate(values);
          });
        }}
      >
        <Typography.Paragraph type="secondary">
          {t("aiSkills.createHint")}
        </Typography.Paragraph>
        <Form
          form={createForm}
          layout="vertical"
          initialValues={{ compatible_kinds: ["ops"] }}
        >
          <Form.Item
            name="name"
            label={t("aiSkills.fieldName")}
            rules={[
              { required: true, message: "Name is required" },
              { max: 80 },
            ]}
            extra={t("aiSkills.fieldNameExtra")}
          >
            <Input placeholder="e.g. patrol-disk-analyst" />
          </Form.Item>
          <Form.Item
            name="description"
            label={t("aiSkills.fieldDescription")}
            rules={[{ max: 500 }]}
          >
            <Input.TextArea
              rows={2}
              placeholder="What this skill teaches the agent to do"
            />
          </Form.Item>
          <Form.Item
            name="compatible_kinds"
            label={t("aiSkills.fieldKinds")}
            rules={[{ required: true, message: "Select at least one kind" }]}
          >
            <Select
              mode="multiple"
              options={[
                {
                  value: "ops",
                  label: t("aiSkills.kindOps"),
                },
                {
                  value: "security",
                  label: t("aiSkills.kindSecurity"),
                },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="body"
            label={t("aiSkills.fieldBody")}
            extra={t("aiSkills.fieldBodyExtra")}
          >
            <Input.TextArea
              rows={10}
              style={{ fontFamily: "monospace" }}
              placeholder={`# Skill instructions\n\nWhen invoked:\n1. ...\n2. Respond with JSON only: {...}`}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
