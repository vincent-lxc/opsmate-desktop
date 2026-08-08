import { useEffect, useRef, useState } from "react";
import { Alert, Card, Spin, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { OpsMateLogo } from "../components/OpsMateLogo";
import { HeaderActions } from "../components/HeaderActions";
import {
  mustChangePassword,
  roleFromToken,
  setAuthSession,
  type AdminRole,
} from "../services/auth/roles";
import {
  consumeLogtoCallbackParams,
  type LogtoPublicConfig,
} from "../services/auth/logto-pkce";

type SessionResponse = {
  token: string;
  username: string;
  role: AdminRole;
  must_change_password?: boolean;
};

export function LogtoCallbackPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    void (async () => {
      try {
        const { code, codeVerifier } = consumeLogtoCallbackParams(window.location.search);
        const config = await api<LogtoPublicConfig>("/api/auth/logto/config");
        if (!config.enabled || !config.redirectUri) {
          throw new Error(t("login.logtoDisabled"));
        }
        const session = await api<SessionResponse>("/api/auth/logto/exchange", {
          method: "POST",
          body: JSON.stringify({
            code,
            codeVerifier,
            redirectUri: config.redirectUri,
          }),
        });
        setAuthSession(
          session.token,
          session.role ?? roleFromToken(session.token),
          session.username,
          session.must_change_password,
        );
        window.location.href = mustChangePassword()
          ? "/account?tab=security"
          : "/dashboard/overview";
      } catch (err) {
        setError(err instanceof Error ? err.message : t("login.logtoFailed"));
      }
    })();
  }, [t, navigate]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--ant-color-bg-layout)" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 24px" }}>
        <HeaderActions />
      </div>
      <div style={{ display: "flex", justifyContent: "center", padding: "48px 16px" }}>
        <Card style={{ width: 420, maxWidth: "100%", textAlign: "center" }}>
          <OpsMateLogo size={36} />
          <Typography.Title level={4} style={{ marginTop: 16 }}>
            {t("login.logtoCallbackTitle")}
          </Typography.Title>
          {error ? (
            <Alert
              type="error"
              showIcon
              message={error}
              style={{ marginTop: 16, textAlign: "left" }}
              action={
                <Typography.Link href="/login">{t("login.backToLogin")}</Typography.Link>
              }
            />
          ) : (
            <div style={{ marginTop: 24 }}>
              <Spin />
              <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
                {t("login.logtoCallbackHint")}
              </Typography.Paragraph>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

export default LogtoCallbackPage;
