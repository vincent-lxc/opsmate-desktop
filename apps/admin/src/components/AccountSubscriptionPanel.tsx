import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Col,
  Divider,
  InputNumber,
  Progress,
  Row,
  Segmented,
  Space,
  Spin,
  Statistic,
  Tag,
  Typography,
  message,
} from "antd";
import { ProCard } from "@ant-design/pro-components";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { openExternalRoute } from "../desktop/external-navigation";
import { isDesktopRuntime } from "../desktop/tauri-bridge";

type AIPlanInterval = "month" | "year";

type AISubscriptionStatus = {
  period: string;
  usage: {
    used: number;
    base_quota: number | null;
    paid_quota: number;
    total_quota: number | null;
    remaining: number | null;
  };
  subscription: {
    status: string | null;
    interval: AIPlanInterval | null;
    quantity: number;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    can_checkout: boolean;
    can_manage: boolean;
  };
  billing_configured: boolean;
};

type AccountSubscriptionPanelProps = {
  role: string;
  checkoutSuccess?: boolean;
};

const ADMIN_ROLES = new Set(["workspace_owner", "admin"]);

/** First checkout not completed — never collapse to manage-only. */
const PENDING_FIRST_CHECKOUT_STATUSES = new Set(["incomplete"]);

function formatNumber(value: number | null): string {
  return value == null ? "∞" : value.toLocaleString("en-US");
}

function assertStripeHttpsUrl(value: string): string {
  const url = new URL(value);
  const stripeHost = url.hostname === "stripe.com" || url.hostname.endsWith(".stripe.com");
  if (url.protocol !== "https:" || !stripeHost) {
    throw new Error("Invalid Stripe redirect URL");
  }
  return url.toString();
}

/**
 * Deterministic subscription action visibility.
 * Does not blindly trust can_manage: incomplete first checkout always
 * exposes continue-payment even when backend flags are inconsistent.
 */
export function resolveSubscriptionActions(
  subscription: AISubscriptionStatus["subscription"],
  billingConfigured: boolean,
  canAdminister: boolean,
): {
  showManage: boolean;
  showCheckout: boolean;
  pendingCheckout: boolean;
  replacingSubscription: boolean;
} {
  const status = subscription.status;
  const pendingCheckout = status != null && PENDING_FIRST_CHECKOUT_STATUSES.has(status);
  const showManage =
    canAdminister
    && billingConfigured
    && subscription.can_manage
    && !pendingCheckout;
  const showCheckout =
    canAdminister
    && billingConfigured
    && (subscription.can_checkout || pendingCheckout);
  const replacingSubscription = showCheckout && showManage && !pendingCheckout;
  return { showManage, showCheckout, pendingCheckout, replacingSubscription };
}

export function AccountSubscriptionPanel({
  role,
  checkoutSuccess = false,
}: AccountSubscriptionPanelProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AISubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [interval, setInterval] = useState<AIPlanInterval>("month");
  const [quantity, setQuantity] = useState<number | null>(1);
  const canAdminister = ADMIN_ROLES.has(role);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api<AISubscriptionStatus>("/api/subscription/ai"));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("account.subscription.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!checkoutSuccess) return;
    const timer = window.setTimeout(() => void loadStatus(), 250);
    return () => window.clearTimeout(timer);
  }, [checkoutSuccess, loadStatus]);

  const startBillingAction = async (path: "checkout" | "portal", body?: unknown) => {
    setSubmitting(true);
    try {
      // Desktop: never location.assign Stripe URLs and never send them to Rust.
      // Open fixed routes so checkout/portal run in the system browser context.
      if (isDesktopRuntime()) {
        await openExternalRoute(path === "portal" ? "account_subscription" : "checkout");
        setSubmitting(false);
        return;
      }
      const result = await api<{ url: string }>(`/api/subscription/ai/${path}`, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      window.location.assign(assertStripeHttpsUrl(result.url));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("account.subscription.actionFailed"));
      setSubmitting(false);
    }
  };

  if (loading || !status) return <Spin />;

  const safeQuantity = Number.isSafeInteger(quantity) && Number(quantity) > 0
    ? Number(quantity)
    : 0;
  const addedQuota = safeQuantity * 500;
  const price = safeQuantity * (interval === "year" ? 100 : 10);
  const percent = status.usage.total_quota == null || status.usage.total_quota <= 0
    ? 0
    : Math.min(100, Math.round((status.usage.used / status.usage.total_quota) * 100));
  const {
    showManage,
    showCheckout,
    pendingCheckout,
    replacingSubscription,
  } = resolveSubscriptionActions(
    status.subscription,
    status.billing_configured,
    canAdminister,
  );

  return (
    <ProCard title={t("account.subscription.usageTitle")}>
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        {checkoutSuccess ? (
          <Alert
            type="success"
            showIcon
            message={t("account.subscription.checkoutSuccess")}
          />
        ) : null}

        {canAdminister && !status.billing_configured ? (
          <Alert
            type="warning"
            showIcon
            message={t("account.subscription.billingUnavailable")}
          />
        ) : null}

        <Row gutter={[24, 16]} align="middle">
          <Col xs={24} md={12}>
            <Statistic
              title={t("account.subscription.monthUsage", { period: status.period })}
              value={status.usage.used}
              formatter={() => `${formatNumber(status.usage.used)} / ${formatNumber(status.usage.total_quota)}`}
            />
            <Progress percent={percent} showInfo={false} style={{ maxWidth: 420 }} />
          </Col>
          <Col xs={24} md={12}>
            <Space direction="vertical" size="small">
              <Typography.Text>
                {t("account.subscription.baseQuota", {
                  count: formatNumber(status.usage.base_quota),
                })}
              </Typography.Text>
              <Typography.Text>
                {t("account.subscription.paidQuota", {
                  count: formatNumber(status.usage.paid_quota),
                })}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t("account.subscription.remaining", {
                  count: formatNumber(status.usage.remaining),
                })}
              </Typography.Text>
              {status.subscription.status ? (
                <Tag color={status.subscription.status === "active" ? "success" : "warning"}>
                  {t("account.subscription.status", { status: status.subscription.status })}
                </Tag>
              ) : null}
            </Space>
          </Col>
        </Row>

        {showManage ? (
          <Button
            type="primary"
            loading={submitting}
            onClick={() => void startBillingAction("portal")}
          >
            {t("account.subscription.manage")}
          </Button>
        ) : null}

        {showCheckout ? (
          <>
            <Divider />
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                {t("account.subscription.addQuota")}
              </Typography.Title>
              {pendingCheckout ? (
                <Alert
                  type="warning"
                  showIcon
                  message={t("account.subscription.checkoutPending")}
                />
              ) : null}
              {!pendingCheckout ? (
                <>
                  <Segmented<AIPlanInterval>
                    value={interval}
                    options={[
                      { label: t("account.subscription.monthly"), value: "month" },
                      { label: t("account.subscription.yearly"), value: "year" },
                    ]}
                    onChange={setInterval}
                  />
                  <InputNumber
                    aria-label={t("account.subscription.quantity")}
                    min={1}
                    precision={0}
                    value={quantity}
                    onChange={setQuantity}
                  />
                  <Typography.Text>
                    {t("account.subscription.addedQuota", { count: formatNumber(addedQuota) })}
                  </Typography.Text>
                  <Typography.Title level={4} style={{ margin: 0 }}>
                    ${price.toLocaleString("en-US")} / {interval === "year"
                      ? t("account.subscription.yearUnit")
                      : t("account.subscription.monthUnit")}
                  </Typography.Title>
                  {interval === "year" ? (
                    <Typography.Text type="secondary">
                      {t("account.subscription.yearlySaving")}
                    </Typography.Text>
                  ) : null}
                </>
              ) : null}
              <Button
                type="primary"
                loading={submitting}
                disabled={
                  (!pendingCheckout && safeQuantity === 0) || !status.billing_configured
                }
                onClick={() => void startBillingAction("checkout", {
                  interval,
                  quantity: safeQuantity,
                })}
              >
                {pendingCheckout
                  ? t("account.subscription.continueCheckout")
                  : replacingSubscription
                    ? t("account.subscription.resubscribe")
                    : t("account.subscription.subscribe")}
              </Button>
            </Space>
          </>
        ) : null}
      </Space>
    </ProCard>
  );
}
