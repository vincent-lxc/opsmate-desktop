import { Tag } from "antd";
import { CrownOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { SelectLang } from "./SelectLang";
import { ThemeToggle } from "./ThemeToggle";
import { useEntitlements } from "../providers/EntitlementsProvider";
import type { EditionPlan } from "../services/entitlements";

/**
 * U5: edition badge in the header. Shows the current tenant's plan so users
 * always know which edition they're on. Enterprise gets a gold tag; Free gets
 * a neutral grey tag. The entitlements provider fail-opens to enterprise
 * for dev/internal installs, so the badge reflects the real plan only when
 * /api/entitlements/current resolved successfully.
 */
const PLAN_TAG_COLOR: Record<EditionPlan, string> = {
  free: "default",
  enterprise: "gold",
};

export function HeaderActions() {
  const { t } = useTranslation();
  const { entitlements } = useEntitlements();
  const plan = entitlements.plan;
  const label = t(`header.planBadge.${plan}`);

  return (
    <>
      <Tag color={PLAN_TAG_COLOR[plan]} icon={<CrownOutlined />} style={{ marginRight: 8 }}>
        {label}
      </Tag>
      <ThemeToggle />
      <SelectLang />
    </>
  );
}
