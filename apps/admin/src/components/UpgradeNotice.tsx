import { Alert, Button, Space, Typography } from "antd";
import { LockOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useEntitlements } from "../providers/EntitlementsProvider";
import type { FeatureKey } from "../services/entitlements";

/**
 * U5: upgrade prompt shown when a tenant hits an edition-gated capability it
 * doesn't have. The backend feature gates remain the source of truth — this is
 * the UX surface for the case where a free user deep-links an Enterprise
 * page directly (the menu hides these entries, but URLs are reachable). The
 * component is also used by `RequireFeature` to wrap gated routes.
 *
 * The public SaaS has only permanent Free; capabilities outside that matrix are
 * available through the contract-managed Enterprise edition.
 */
type UpgradeNoticeProps = {
  feature: FeatureKey;
  /** Optional page title rendered above the alert (used by RequireFeature). */
  title?: string;
};

export function UpgradeNotice({ feature, title }: UpgradeNoticeProps) {
  const { t } = useTranslation();
  const { entitlements } = useEntitlements();
  const currentPlan = entitlements.plan;

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      {title ? <Typography.Title level={4}>{title}</Typography.Title> : null}
      <Alert
        data-feature={feature}
        type="warning"
        showIcon
        icon={<LockOutlined />}
        message={t("upgrade.title")}
        description={
          <Space direction="vertical" size="small">
            <Typography.Text>{t("upgrade.hint")}</Typography.Text>
            <Typography.Text type="secondary">
              {t("upgrade.currentPlan", { plan: t(`header.planBadge.${currentPlan}`) })}
            </Typography.Text>
            <Button type="primary" href="https://www.itops.sh/#contact" target="_blank" rel="noreferrer">
              {t("upgrade.cta")}
            </Button>
          </Space>
        }
      />
    </Space>
  );
}
