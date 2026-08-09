import { ProFormDependency, ProFormTextArea } from "@ant-design/pro-components";
import { Alert, Collapse, Typography } from "antd";
import { useTranslation } from "react-i18next";
import type { CheckType } from "../utils/monitoring-types";
import { CHECK_TYPE_CONFIG_FIELDS } from "../utils/monitor-step-config-help";

type MonitorStepConfigFieldProps = {
  initialConfig?: Record<string, unknown>;
  /** When true, wraps the editor in a collapsible panel (foundation form style). */
  collapsible?: boolean;
  label?: string;
};

function ConfigHelpPanel({ checkType }: { checkType: CheckType }) {
  const { t } = useTranslation();
  const fields = CHECK_TYPE_CONFIG_FIELDS[checkType] ?? [];

  return (
    <div style={{ marginBottom: 12 }}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={t(`monitoring.configHelp.types.${checkType}.intro`, {
          defaultValue: t("monitoring.configHelp.fallbackIntro"),
        })}
      />
      {fields.length > 0 ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          {t("monitoring.configHelp.fieldsTitle")}
        </Typography.Paragraph>
      ) : null}
      {fields.length > 0 ? (
        <ul style={{ margin: "0 0 12px", paddingLeft: 20 }}>
          {fields.map((field) => (
            <li key={field} style={{ marginBottom: 4 }}>
              <Typography.Text code>{field}</Typography.Text>
              {" — "}
              <Typography.Text type="secondary">
                {t(`monitoring.configHelp.fields.${field}`, { defaultValue: field })}
              </Typography.Text>
            </li>
          ))}
        </ul>
      ) : null}
      <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>
        {t("monitoring.configHelp.exampleTitle")}
      </Typography.Paragraph>
      <Typography.Paragraph>
        <Typography.Text code style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {t(`monitoring.configHelp.types.${checkType}.example`, {
            defaultValue: "{}",
          })}
        </Typography.Text>
      </Typography.Paragraph>
    </div>
  );
}

export function MonitorStepConfigField({
  initialConfig,
  collapsible = false,
  label,
}: MonitorStepConfigFieldProps) {
  const { t } = useTranslation();
  const configLabel = label ?? t("monitoring.foundation.columns.config");
  const initialJson = initialConfig ? JSON.stringify(initialConfig, null, 2) : "{}";

  const editor = (
    <ProFormDependency name={["check_type"]}>
      {({ check_type }) => {
        const checkType = (check_type as CheckType | undefined) ?? "ssh_command";
        return (
          <>
            <ConfigHelpPanel checkType={checkType} />
            <ProFormTextArea
              name="configJson"
              label={collapsible ? false : configLabel}
              fieldProps={{ rows: 10, style: { fontFamily: "monospace" } }}
              placeholder="{}"
              initialValue={initialJson}
            />
          </>
        );
      }}
    </ProFormDependency>
  );

  if (!collapsible) {
    return editor;
  }

  return (
    <Collapse
      bordered={false}
      defaultActiveKey={["config"]}
      items={[
        {
          key: "config",
          label: configLabel,
          children: editor,
        },
      ]}
    />
  );
}