import {
  ProForm,
  ProFormDigit,
  ProFormSelect,
  ProFormText,
} from "@ant-design/pro-components";
import { ApiOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Collapse, Spin, Tag } from "antd";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import type { ProFormInstance } from "@ant-design/pro-components";

import { useTranslation } from "react-i18next";
import { ApiError, api } from "../api/client";
import { useEntitlements } from "../providers/EntitlementsProvider";
import type { EditionPlan } from "../services/entitlements";
import {
  AI_CONFIG_DEFAULTS,
  AI_PROVIDER_PRESETS,
  type AIProvider,
} from "../utils/ai-provider-presets";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AIProviderMode = "managed_platform" | "customer";

interface AIConfigResponse {
  mode: AIProviderMode;
  plan: EditionPlan;
  provider: AIProvider;
  endpoint: string;
  model_name: string;
  similarity_threshold: number;
  temperature: number;
  configured: boolean;
  api_key_masked: string;
  api_key_configured: boolean;
  /** Backend-derived: true when the tenant may supply its own API key. */
  can_configure_key: boolean;
}

interface AIConfigFormValues {
  provider: AIProvider;
  api_base: string;
  model: string;
  api_key?: string;
  similarity_threshold: number;
  temperature: number;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AIProviderConfig() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const { entitlements } = useEntitlements();
  const formRef = useRef<ProFormInstance<AIConfigFormValues> | undefined>(
    undefined,
  );

  const { data: config, isLoading } = useQuery<AIConfigResponse>({
    queryKey: ["ai-config"],
    queryFn: () => api<AIConfigResponse>("/api/config/ai"),
  });

  const testMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ message: string; chat_latency_ms: number }>(
        "/api/config/ai/test",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
  });

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ message: string }>("/api/config/ai", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      message.success(data.message ?? t("aiConfig.saved"));
      queryClient.invalidateQueries({ queryKey: ["ai-config"] });
    },
    onError: (err: Error) => {
      message.error(err.message ?? t("aiConfig.saveFailed"));
    },
  });

  const providerOptions = useMemo(
    () => [
      { value: "openai", label: t("aiConfig.providerOpenai") },
      { value: "ollama", label: t("aiConfig.providerOllama") },
      { value: "custom", label: t("aiConfig.providerCustom") },
    ],
    [t],
  );

  // Backend-derived gate. Free tenants get OpsMate-managed AI and cannot set a
  // key; the route POSTs 403 PLAN_UPGRADE_REQUIRED if they try. The entitlements
  // hook plan is a fallback used only before the config fetch resolves.
  const canConfigureKey = config?.can_configure_key ?? entitlements.plan !== "free";
  const mode = config?.mode ?? "managed_platform";
  const modeTagLabel = useMemo(() => {
    if (mode === "customer") return t("aiConfig.modeCustomer");
    return t("aiConfig.modeManaged");
  }, [mode, t]);

  const initialValues = useMemo<AIConfigFormValues>(() => {
    const provider = config?.provider ?? AI_CONFIG_DEFAULTS.provider;
    const preset = AI_PROVIDER_PRESETS[provider];
    return {
      provider,
      api_base: config?.endpoint || preset.api_base,
      model: config?.model_name || preset.model,
      similarity_threshold:
        config?.similarity_threshold ?? AI_CONFIG_DEFAULTS.similarity_threshold,
      temperature: config?.temperature ?? AI_CONFIG_DEFAULTS.temperature,
    };
  }, [config]);

  if (isLoading) {
    return (
      <Card title={t("aiConfig.title")}>
        <Spin style={{ display: "block", margin: "48px auto" }} />
      </Card>
    );
  }

  // Free tenants: managed-platform-only, no key configuration.
  if (!canConfigureKey) {
    return (
      <Card
        variant="borderless"
        title={t("aiConfig.title")}
        style={{ maxWidth: 720, margin: "0 auto" }}
      >
        <Alert
          type="info"
          showIcon
          message={t("aiConfig.managedModeTitle")}
          description={
            <>
              <p style={{ marginBottom: 8 }}>{t("aiConfig.freeNotice")}</p>
              <Tag color="blue">{modeTagLabel}</Tag>
            </>
          }
        />
      </Card>
    );
  }

  // Enterprise/default: show the mode banner + configurable form.
  const modeAlert =
    mode === "managed_platform"
      ? { type: "info" as const, message: t("aiConfig.managedModeTitle"), desc: t("aiConfig.enterpriseHint") }
      : { type: "success" as const, message: t("aiConfig.ownProviderActive"), desc: t("aiConfig.enterpriseHint") };

  return (
    <Card
      variant="borderless"
      title={t("aiConfig.title")}
      style={{ maxWidth: 720, margin: "0 auto" }}
    >
      <Alert
        type={modeAlert.type}
        showIcon
        style={{ marginBottom: 16 }}
        message={
          <span>
            {modeAlert.message}{" "}
            <Tag color={mode === "managed_platform" ? "blue" : "green"}>
              {modeTagLabel}
            </Tag>
          </span>
        }
        description={modeAlert.desc}
      />

      <ProForm<AIConfigFormValues>
        formRef={formRef}
        key={config ? "loaded" : "loading"}
        onFinish={async (values) => {
          const body: Record<string, unknown> = {
            provider: values.provider,
            api_base: values.api_base ?? "",
            model: values.model ?? "",
            similarity_threshold: values.similarity_threshold,
            temperature: values.temperature,
          };
          if (values.api_key?.trim()) {
            body.api_key = values.api_key.trim();
          }
          await saveMutation.mutateAsync(body);
        }}
        submitter={{
          searchConfig: { submitText: t("aiConfig.save") },
          resetButtonProps: { style: { display: "none" } },
          render: (_, dom) => (
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
              <Button
                icon={<ApiOutlined />}
                loading={testMutation.isPending}
                onClick={async () => {
                  try {
                    const values = await formRef.current?.validateFieldsReturnFormatValue?.();
                    if (!values) return;
                    const body: Record<string, unknown> = {
                      api_base: values.api_base,
                      model: values.model,
                    };
                    if (values.api_key?.trim()) {
                      body.api_key = values.api_key.trim();
                    }
                    const result = await testMutation.mutateAsync(body);
                    message.success(result.message ?? t("aiConfig.testSuccess"));
                  } catch (error) {
                    const text =
                      error instanceof ApiError
                        ? error.message
                        : error instanceof Error
                          ? error.message
                          : t("aiConfig.testFailed");
                    message.error(text);
                  }
                }}
              >
                {t("aiConfig.test")}
              </Button>
              {dom}
            </div>
          ),
        }}
        initialValues={initialValues}
        layout="vertical"
      >
        <ProFormSelect
          name="provider"
          label={t("aiConfig.provider")}
          options={providerOptions}
          fieldProps={{
            size: "large",
            onChange: (value: AIProvider) => {
              if (value === "custom") return;
              const preset = AI_PROVIDER_PRESETS[value];
              formRef.current?.setFieldsValue({
                provider: value,
                api_base: preset.api_base,
                model: preset.model,
              });
            },
          }}
        />

        <ProFormText
          name="api_base"
          label={t("aiConfig.endpoint")}
          placeholder="https://api.openai.com/v1"
          fieldProps={{ size: "large" }}
          rules={[{ type: "url", message: t("aiConfig.invalidUrl") }]}
        />

        <ProFormText
          name="model"
          label={t("aiConfig.modelName")}
          placeholder="gpt-4o-mini"
          fieldProps={{ size: "large" }}
          rules={[{ required: true, message: t("aiConfig.modelRequired") }]}
          extra={t("aiConfig.chatModelExtra")}
        />

        <ProFormText.Password
          name="api_key"
          label={t("aiConfig.apiKey")}
          placeholder={
            config?.api_key_configured
              ? t("aiConfig.placeholderKeyChange")
              : "sk-..."
          }
          fieldProps={{ size: "large" }}
        />

        {config?.api_key_configured && (
          <div
            style={{
              marginTop: -8,
              marginBottom: 16,
              fontSize: 12,
              color: "rgba(0,0,0,0.45)",
            }}
          >
            {t("aiConfig.currentKey", { masked: config.api_key_masked })}
          </div>
        )}

        <ProFormDigit
          name="similarity_threshold"
          label={t("aiConfig.similarityThreshold")}
          min={0}
          max={1}
          step={0.05}
          fieldProps={{ precision: 2, size: "large", style: { width: "100%" } }}
          extra={t("aiConfig.similarityThresholdExtra")}
        />

        <Collapse
          bordered={false}
          style={{ marginBottom: 24, background: "transparent" }}
          items={[
            {
              key: "advanced",
              label: t("aiConfig.advancedTitle"),
              children: (
                <>
                  <ProFormDigit
                    name="temperature"
                    label={t("aiConfig.temperature")}
                    min={0}
                    max={2}
                    step={0.1}
                    fieldProps={{
                      precision: 1,
                      size: "large",
                      style: { width: "100%" },
                    }}
                    extra={t("aiConfig.temperatureExtra")}
                  />
                </>
              ),
            },
          ]}
        />
      </ProForm>
    </Card>
  );
}
