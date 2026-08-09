import {
  App,
  Button,
  Checkbox,
  Input,
  Modal,
  Radio,
  Select,
  Upload,
} from "antd";
import { UploadOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { ApplicationProfile, DependencyManifestSet } from "../utils/monitoring-types";

const ALLOWED_MANIFEST_FILENAMES = new Set([
  "go.mod",
  "go.sum",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "requirements.txt",
  "Pipfile",
  "poetry.lock",
  "Gemfile",
  "Gemfile.lock",
  "Cargo.toml",
  "Cargo.lock",
  "composer.json",
  "composer.lock",
]);

type StagedManifest = { filename: string; content: string };

type Props = {
  open: boolean;
  profile: ApplicationProfile | null;
  onClose: () => void;
};

export function ApplicationManifestLinkModal({ open, profile, onClose }: Props) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [uploadMode, setUploadMode] = useState<"link" | "new">("link");
  const [selectedManifestSetId, setSelectedManifestSetId] = useState<string | undefined>();
  const [createSetName, setCreateSetName] = useState("");
  const [stagedManifests, setStagedManifests] = useState<StagedManifest[]>([]);
  const [analyzeAfterUpload, setAnalyzeAfterUpload] = useState(true);

  const { data: manifestSets } = useQuery({
    queryKey: ["dependency-manifest-sets"],
    queryFn: () => api<{ items: DependencyManifestSet[] }>("/api/monitoring/dependency-manifest-sets"),
    enabled: open,
  });

  useEffect(() => {
    if (!open || !profile) return;
    setUploadMode(profile.manifest_set_id ? "link" : "new");
    setSelectedManifestSetId(profile.manifest_set_id ?? undefined);
    setCreateSetName(`${profile.service_name}-manifests`);
    setStagedManifests([]);
    setAnalyzeAfterUpload(true);
  }, [open, profile]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["monitoring-applications"] });
    if (profile) {
      void queryClient.invalidateQueries({
        queryKey: ["monitoring-application-detail", profile.id],
      });
    }
    void queryClient.invalidateQueries({ queryKey: ["dependency-manifest-sets"] });
  };

  const linkMutation = useMutation({
    mutationFn: (manifestSetId: string) =>
      api(`/api/monitoring/applications/${profile!.id}/manifest-set`, {
        method: "PUT",
        body: JSON.stringify({ manifest_set_id: manifestSetId }),
      }),
    onSuccess: () => {
      message.success(t("monitoring.applications.linkedManifestSetSuccess"));
      refresh();
      onClose();
    },
    onError: () => message.error(t("common.error")),
  });

  const uploadMutation = useMutation({
    mutationFn: (payload: {
      manifests: StagedManifest[];
      create_set_name?: string;
      manifest_set_id?: string;
      analyze: boolean;
    }) =>
      api<{
        summary?: string;
        uploaded_count: number;
        analyzed: boolean;
        analyze_failed?: boolean;
        analyze_error?: string;
      }>(`/api/monitoring/applications/${profile!.id}/manifests`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      if (data.analyze_failed) {
        message.warning(
          t("monitoring.applications.uploadManifestsAnalyzeFailed", {
            count: data.uploaded_count,
            error: data.analyze_error ?? "",
          }),
        );
      } else if (data.analyzed && data.summary) {
        message.success(
          `${t("monitoring.applications.uploadManifestsSuccessAnalyzed", {
            count: data.uploaded_count,
          })} — ${data.summary}`,
        );
      } else if (data.analyzed) {
        message.success(
          t("monitoring.applications.uploadManifestsSuccessAnalyzed", {
            count: data.uploaded_count,
          }),
        );
      } else {
        message.success(
          t("monitoring.applications.uploadManifestsSuccess", { count: data.uploaded_count }),
        );
      }
      refresh();
      onClose();
    },
    onError: (err: Error) => {
      const code =
        err instanceof ApiError ? (err.body as { code?: string } | undefined)?.code : undefined;
      if (code === "INVALID_MANIFEST") {
        message.error(t("monitoring.applications.uploadManifestsInvalid"));
        return;
      }
      message.error(t("monitoring.applications.uploadManifestsFailed"));
    },
  });

  const isSubmitting = linkMutation.isPending || uploadMutation.isPending;

  const handleSubmit = () => {
    if (!profile) return;
    if (uploadMode === "link") {
      if (!selectedManifestSetId) {
        message.error(t("monitoring.applications.selectManifestSetPlaceholder"));
        return;
      }
      linkMutation.mutate(selectedManifestSetId);
      return;
    }
    if (!stagedManifests.length) {
      message.error(t("monitoring.applications.uploadManifestsEmpty"));
      return;
    }
    uploadMutation.mutate({
      manifests: stagedManifests,
      create_set_name: createSetName.trim() || `${profile.service_name}-manifests`,
      manifest_set_id: selectedManifestSetId,
      analyze: analyzeAfterUpload,
    });
  };

  return (
    <Modal
      title={t("monitoring.applications.linkDependenciesTitle")}
      open={open}
      onCancel={() => {
        onClose();
        setStagedManifests([]);
      }}
      onOk={handleSubmit}
      confirmLoading={isSubmitting}
      okText={
        uploadMode === "link"
          ? t("monitoring.applications.linkManifestSetSubmit")
          : t("monitoring.applications.uploadManifestsSubmit")
      }
      destroyOnClose
    >
      <p style={{ fontSize: 12, color: "var(--ant-color-text-secondary)", marginBottom: 12 }}>
        {t("monitoring.applications.uploadManifestsHint")}{" "}
        <Link to="/monitoring/dependency-manifests">
          {t("monitoring.applications.manageManifestSets")}
        </Link>
      </p>
      <Radio.Group
        style={{ marginBottom: 12 }}
        value={uploadMode}
        onChange={(e) => setUploadMode(e.target.value as "link" | "new")}
      >
        <Radio.Button value="link">{t("monitoring.applications.uploadModeLink")}</Radio.Button>
        <Radio.Button value="new">{t("monitoring.applications.uploadModeNew")}</Radio.Button>
      </Radio.Group>
      {uploadMode === "link" ? (
        <Select
          style={{ width: "100%", marginBottom: 12 }}
          placeholder={t("monitoring.applications.selectManifestSetPlaceholder")}
          value={selectedManifestSetId}
          onChange={setSelectedManifestSetId}
          options={(manifestSets?.items ?? []).map((item) => ({
            label: `${item.name} (${item.manifests.length} files, ${item.profile_count} apps)`,
            value: item.id,
          }))}
        />
      ) : (
        <>
          <Input
            style={{ marginBottom: 12 }}
            placeholder={t("monitoring.applications.createSetName")}
            value={createSetName}
            onChange={(e) => setCreateSetName(e.target.value)}
          />
          <Upload.Dragger
            multiple
            showUploadList={false}
            beforeUpload={(file) => {
              const baseName = file.name.split(/[/\\]/).pop() ?? file.name;
              if (!ALLOWED_MANIFEST_FILENAMES.has(baseName)) {
                message.error(`${t("monitoring.applications.uploadManifestsInvalid")}: ${baseName}`);
                return Upload.LIST_IGNORE;
              }
              const reader = new FileReader();
              reader.onload = () => {
                const content = typeof reader.result === "string" ? reader.result.trim() : "";
                if (!content) {
                  message.error(t("monitoring.applications.uploadManifestsEmpty"));
                  return;
                }
                setStagedManifests((prev) => [
                  ...prev.filter((item) => item.filename !== baseName),
                  { filename: baseName, content },
                ]);
              };
              reader.onerror = () => message.error(t("servers.form.uploadFailed"));
              reader.readAsText(file);
              return false;
            }}
          >
            <p className="ant-upload-drag-icon">
              <UploadOutlined />
            </p>
            <p className="ant-upload-text">{t("monitoring.applications.uploadManifests")}</p>
          </Upload.Dragger>
          {stagedManifests.length > 0 ? (
            <ul style={{ marginTop: 12, paddingLeft: 20, fontSize: 12 }}>
              {stagedManifests.map((item) => (
                <li key={item.filename}>{item.filename}</li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      {uploadMode === "new" ? (
        <Checkbox
          style={{ marginTop: 12 }}
          checked={analyzeAfterUpload}
          onChange={(e) => setAnalyzeAfterUpload(e.target.checked)}
        >
          {t("monitoring.applications.analyzeAfterUpload")}
        </Checkbox>
      ) : null}
    </Modal>
  );
}