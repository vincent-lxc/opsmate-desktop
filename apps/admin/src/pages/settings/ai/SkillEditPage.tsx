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
  Tabs,
  Typography,
  List,
  Popconfirm,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { platformAiApi } from "../../../api/platform-ai";

export default function SkillEditPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [metaForm] = Form.useForm();
  const [body, setBody] = useState("");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addPrefix, setAddPrefix] = useState<"references/" | "scripts/" | "assets/">(
    "references/",
  );
  const [addForm] = Form.useForm<{ filename: string; content: string }>();

  const { data: skill, isLoading } = useQuery({
    queryKey: ["platform-ai-skill", id],
    queryFn: () => platformAiApi.getSkill(id),
    enabled: Boolean(id),
  });

  useEffect(() => {
    if (!skill) return;
    metaForm.setFieldsValue({
      name: skill.name,
      description: skill.description,
      compatible_kinds: skill.compatible_kinds,
      is_enabled: skill.is_enabled,
    });
    setBody(skill.body_md ?? "");
  }, [skill, metaForm]);

  const files = skill?.files ?? [];
  const refFiles = useMemo(
    () => files.filter((f) => f.startsWith("references/")),
    [files],
  );
  const scriptFiles = useMemo(
    () => files.filter((f) => f.startsWith("scripts/")),
    [files],
  );
  const assetFiles = useMemo(
    () =>
      files.filter(
        (f) =>
          f.startsWith("assets/") ||
          (!f.startsWith("scripts/") &&
            !f.startsWith("references/") &&
            f !== "SKILL.md"),
      ),
    [files],
  );

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["platform-ai-skill", id] });
    void qc.invalidateQueries({ queryKey: ["platform-ai-skills"] });
  };

  const metaMutation = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      platformAiApi.patchSkillMeta(id, values),
    onSuccess: () => {
      message.success(t("aiSkills.metaSaved"));
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const bodyMutation = useMutation({
    mutationFn: () => platformAiApi.putSkillBody(id, body),
    onSuccess: () => {
      message.success(t("aiSkills.bodySaved"));
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const fileMutation = useMutation({
    mutationFn: () => {
      if (!filePath) throw new Error("No file selected");
      return platformAiApi.putSkillFile(id, filePath, fileContent);
    },
    onSuccess: () => {
      message.success(t("aiSkills.fileSaved"));
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const addFileMutation = useMutation({
    mutationFn: (input: { path: string; content: string }) =>
      platformAiApi.putSkillFile(id, input.path, input.content),
    onSuccess: (_skill, vars) => {
      message.success(t("aiSkills.fileCreated"));
      setAddOpen(false);
      addForm.resetFields();
      invalidate();
      void loadFile(vars.path);
    },
    onError: (e: Error) => message.error(e.message),
  });

  const deleteFileMutation = useMutation({
    mutationFn: (path: string) => platformAiApi.deleteSkillFile(id, path),
    onSuccess: () => {
      message.success(t("aiSkills.fileDeleted"));
      setFilePath(null);
      setFileContent("");
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const loadFile = async (path: string) => {
    setFilePath(path);
    try {
      const res = await platformAiApi.getSkillFile(id, path);
      setFileContent(res.content);
    } catch (e) {
      message.error(e instanceof Error ? e.message : t("aiSkills.fileLoadFailed"));
    }
  };

  const openAdd = (prefix: "references/" | "scripts/" | "assets/") => {
    setAddPrefix(prefix);
    addForm.setFieldsValue({
      filename:
        prefix === "scripts/"
          ? "check.mjs"
          : prefix === "references/"
            ? "schema.md"
            : "note.txt",
      content:
        prefix === "scripts/"
          ? `// Skill script — stdin may contain JSON args; write result to stdout.\nconsole.log(JSON.stringify({ ok: true }));\n`
          : prefix === "references/"
            ? "# Reference\n\n"
            : "",
    });
    setAddOpen(true);
  };

  const exportSkill = async () => {
    try {
      const res = await platformAiApi.exportSkill(id);
      const blob = new Blob([JSON.stringify(res, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${skill?.slug ?? id}-export.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      message.error(e instanceof Error ? e.message : t("aiSkills.exportFailed"));
    }
  };

  if (isLoading || !skill) {
    return <Typography.Text>{t("aiSkills.loading")}</Typography.Text>;
  }

  const fileEditor = (
    paths: string[],
    prefix: "references/" | "scripts/" | "assets/",
  ) => (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Button type="dashed" onClick={() => openAdd(prefix)}>
          {t("aiSkills.addFile", { prefix })}
        </Button>
      </Space>
      <div style={{ display: "flex", gap: 16, minHeight: 320 }}>
        <List
          size="small"
          bordered
          style={{ width: 240, maxHeight: 400, overflow: "auto" }}
          dataSource={paths}
          locale={{ emptyText: t("aiSkills.noFiles") }}
          renderItem={(path) => (
            <List.Item
              style={{
                cursor: "pointer",
                background: filePath === path ? "#e6f4ff" : undefined,
              }}
              onClick={() => void loadFile(path)}
              actions={[
                <Popconfirm
                  key="del"
                  title={t("aiSkills.deleteFileConfirm")}
                  onConfirm={(e) => {
                    e?.stopPropagation();
                    deleteFileMutation.mutate(path);
                  }}
                >
                  <Button
                    type="link"
                    danger
                    size="small"
                    onClick={(e) => e.stopPropagation()}
                  >{t("aiSkills.del")}</Button>
                </Popconfirm>,
              ]}
            >
              {path.replace(prefix, "")}
            </List.Item>
          )}
        />
        <div style={{ flex: 1 }}>
          <Typography.Text type="secondary">
            {filePath ?? t("aiSkills.selectFile")}
          </Typography.Text>
          <Input.TextArea
            rows={14}
            value={fileContent}
            disabled={!filePath}
            onChange={(e) => setFileContent(e.target.value)}
            style={{ marginTop: 8, fontFamily: "monospace" }}
          />
          <Button
            type="primary"
            style={{ marginTop: 8 }}
            disabled={!filePath}
            loading={fileMutation.isPending}
            onClick={() => fileMutation.mutate()}
          >
            {t("aiSkills.saveFile")}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button onClick={() => navigate("/settings/ai/skills")}>{t("aiSkills.back")}</Button>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {skill.name}{" "}
          <Typography.Text type="secondary">v{skill.version}</Typography.Text>
        </Typography.Title>
        <Button onClick={() => void exportSkill()}>{t("aiSkills.export")}</Button>
      </Space>

      <Tabs
        items={[
          {
            key: "meta",
            label: t("aiSkills.tabMeta"),
            children: (
              <Form
                form={metaForm}
                layout="vertical"
                onFinish={(values) => metaMutation.mutate(values)}
              >
                <Form.Item name="name" label={t("common.name")} rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
                <Form.Item name="description" label={t("common.description")}>
                  <Input.TextArea rows={3} />
                </Form.Item>
                <Form.Item name="compatible_kinds" label={t("aiSkills.fieldCompatibleKinds")}>
                  <Select
                    mode="multiple"
                    options={[
                      { value: "ops", label: "ops — 运维" },
                      { value: "security", label: "security — 反渗透" },
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  name="is_enabled"
                  label={t("aiSkills.fieldEnabled")}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={metaMutation.isPending}>
                  {t("aiSkills.saveMeta")}
                </Button>
              </Form>
            ),
          },
          {
            key: "body",
            label: t("aiSkills.tabBody"),
            children: (
              <>
                <Typography.Paragraph type="secondary">
                  {t("aiSkills.bodyHelp")}
                </Typography.Paragraph>
                <Input.TextArea
                  rows={16}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  style={{ fontFamily: "monospace" }}
                />
                <Button
                  type="primary"
                  style={{ marginTop: 8 }}
                  loading={bodyMutation.isPending}
                  onClick={() => bodyMutation.mutate()}
                >
                  {t("aiSkills.saveBody")}
                </Button>
              </>
            ),
          },
          {
            key: "refs",
            label: t("aiSkills.tabRefs"),
            children: fileEditor(refFiles, "references/"),
          },
          {
            key: "scripts",
            label: t("aiSkills.tabScripts"),
            children: fileEditor(scriptFiles, "scripts/"),
          },
          {
            key: "assets",
            label: t("aiSkills.tabAssets"),
            children: fileEditor(assetFiles, "assets/"),
          },
        ]}
      />

      <Modal
        title={t("aiSkills.addFileTitle", { prefix: addPrefix })}
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        okText={t("aiSkills.createFile")}
        confirmLoading={addFileMutation.isPending}
        destroyOnClose
        onOk={() => {
          void addForm.validateFields().then((values) => {
            const name = values.filename.trim().replace(/^\/+/, "");
            if (!name || name.includes("..")) {
              message.error(t("aiSkills.invalidFilename"));
              return;
            }
            const path = `${addPrefix}${name}`;
            addFileMutation.mutate({
              path,
              content: values.content ?? "",
            });
          });
        }}
      >
        <Form form={addForm} layout="vertical">
          <Form.Item
            name="filename"
            label={t("aiSkills.filename", { prefix: addPrefix })}
            rules={[{ required: true }]}
            extra={
              addPrefix === "scripts/"
                ? t("aiSkills.filenameScriptsExtra")
                : undefined
            }
          >
            <Input addonBefore={addPrefix} placeholder="schema.md" />
          </Form.Item>
          <Form.Item name="content" label={t("aiSkills.initialContent")}>
            <Input.TextArea rows={8} style={{ fontFamily: "monospace" }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
