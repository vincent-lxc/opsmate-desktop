import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useEntitlements } from "../providers/EntitlementsProvider";
import type { FeatureKey } from "../services/entitlements";
import { UpgradeNotice } from "./UpgradeNotice";

/**
 * U5: route-level edition guard. When the current tenant's entitlements do not
 * enable `feature`, render an UpgradeNotice instead of `children`. This guards
 * deep-links — the menu already hides gated entries (AdminShell), but a user
 * can still navigate to a gated URL directly. The backend gates remain the
 * source of truth and re-check on every request; this only controls the UX.
 *
 * `title` is the page title shown above the upgrade prompt (matches what the
 * gated page would have rendered as its shell title).
 */
type RequireFeatureProps = {
  feature: FeatureKey;
  title?: string;
  children: ReactNode;
};

export function RequireFeature({ feature, title, children }: RequireFeatureProps) {
  const { t } = useTranslation();
  const { hasFeature } = useEntitlements();
  if (hasFeature(feature)) return <>{children}</>;
  return <UpgradeNotice feature={feature} title={title ?? t("upgrade.lockedPageTitle")} />;
}