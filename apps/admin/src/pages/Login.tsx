import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Space,
  Spin,
  Typography,
  message,
} from "antd";
import { CopyOutlined, DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import { Trans, useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { OpsMateLogo } from "../components/OpsMateLogo";
import { HeaderActions } from "../components/HeaderActions";
import {
  hasActiveSession,
  isLocalDevHost,
  mustChangePassword,
  roleFromToken,
  setAuthSession,
} from "../services/auth/roles";
import { type LogtoPublicConfig } from "../services/auth/logto-pkce";
import { startLogtoLogin } from "../services/auth/start-logto-login";
import { isDesktopRuntime } from "../desktop/tauri-bridge";
import { initNativeAuth, refreshSessionStatus } from "../desktop/native-auth";
import "./login-auth.css";

function wwwBaseUrl(): string {
  const fromEnv = (import.meta.env.VITE_WWW_URL as string | undefined)?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (isLocalDevHost()) return "http://127.0.0.1:5173";
  return "https://itops.sh";
}

function isValidTelegramBotUsername(username: string | undefined): boolean {
  const clean = String(username ?? "")
    .replace(/^@/, "")
    .trim();
  return /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(clean);
}

declare global {
  interface Window {
    onTelegramLogin?: (user: TelegramUser) => void;
  }
}

type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
};

type WidgetConfig = {
  enabled: boolean;
  configured?: boolean;
  error?: "missing_bot_token" | "invalid_bot_token" | "channel_disabled";
  bot_username?: string;
};

function telegramErrorMessage(
  error: WidgetConfig["error"],
  t: (key: string) => string,
): string | null {
  switch (error) {
    case "invalid_bot_token":
      return t("login.telegramInvalidToken");
    case "missing_bot_token":
      return t("login.telegramMissingToken");
    case "channel_disabled":
      return t("login.telegramChannelDisabled");
    default:
      return null;
  }
}

type LoginSession = {
  session_id: string;
  bot_username: string;
  bot_chat_url?: string;
  login_command?: string;
};

function postLoginRedirect() {
  window.location.href = mustChangePassword() ? "/account?tab=security" : "/dashboard/overview";
}

export function LoginPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [widget, setWidget] = useState<WidgetConfig | null>(null);
  const [tgLoading, setTgLoading] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [loginSession, setLoginSession] = useState<LoginSession | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginStatus, setLoginStatus] = useState<"pending" | "consumed" | "expired">("pending");
  const [logtoConfig, setLogtoConfig] = useState<LogtoPublicConfig | null>(null);
  const [logtoLoading, setLogtoLoading] = useState(false);
  /** Required before Logto sign-up (and recommended gate for first-time entry). */
  const [termsAccepted, setTermsAccepted] = useState(false);
  const pollRef = useRef<number | null>(null);
  const www = wwwBaseUrl();

  const preferSignUp =
    searchParams.get("screen") === "register" ||
    searchParams.get("mode") === "signup" ||
    searchParams.get("signup") === "1";

  const [mode, setMode] = useState<"signIn" | "signUp">(preferSignUp ? "signUp" : "signIn");

  useEffect(() => {
    setMode(preferSignUp ? "signUp" : "signIn");
  }, [preferSignUp]);

  // Desktop: after system-browser Logto + deep-link, native session is secret-free.
  // Subscribe/poll and leave Login once authenticated (never via opsmate_token).
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await initNativeAuth();
        const status = await refreshSessionStatus();
        if (!cancelled && (status.authenticated || hasActiveSession())) {
          postLoginRedirect();
        }
      } catch {
        // Ignore missing Tauri surface.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    api<LogtoPublicConfig>("/api/auth/logto/config")
      .then(setLogtoConfig)
      .catch(() =>
        setLogtoConfig({
          enabled: false,
          endpoint: null,
          appId: null,
          redirectUri: "",
          postLogoutRedirectUri: "",
          scopes: [],
        }),
      );
    api<WidgetConfig>("/api/auth/telegram-widget")
      .then(setWidget)
      .catch(() => setWidget({ enabled: false, configured: false }));
  }, []);

  const logtoEnabled = Boolean(logtoConfig?.enabled && logtoConfig.appId && logtoConfig.endpoint);

  /** Sign-up always needs explicit consent; sign-in only when opening register path. */
  const needsTermsGate = mode === "signUp";

  const ensureTermsAccepted = (): boolean => {
    if (!needsTermsGate) return true;
    if (termsAccepted) return true;
    message.warning(t("login.termsRequired"));
    return false;
  };

  const startLogto = async (interaction: "signIn" | "signUp") => {
    if (!logtoConfig) return;
    // Registration must accept ToS/Privacy; pure sign-in can proceed.
    if (interaction === "signUp" && !termsAccepted) {
      message.warning(t("login.termsRequired"));
      return;
    }
    setLogtoLoading(true);
    try {
      // Tauri: native auth_begin_logto (system browser + native PKCE).
      // Browser: existing JS PKCE + window.location.assign.
      await startLogtoLogin(logtoConfig, interaction);
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("login.logtoFailed"));
      setLogtoLoading(false);
    }
  };

  const switchMode = (next: "signIn" | "signUp") => {
    setMode(next);
    const nextParams = new URLSearchParams(searchParams);
    if (next === "signUp") {
      nextParams.set("screen", "register");
    } else {
      nextParams.delete("screen");
      nextParams.delete("mode");
      nextParams.delete("signup");
    }
    setSearchParams(nextParams, { replace: true });
  };

  const startLoginSession = useCallback(async () => {
    setLoginLoading(true);
    try {
      const data = await api<LoginSession>("/api/auth/login/telegram/code", { method: "POST" });
      setLoginSession(data);
      setLoginStatus("pending");
    } catch (err) {
      message.error(err instanceof Error ? err.message : t("login.codeFailed"));
    } finally {
      setLoginLoading(false);
    }
  }, [t]);

  const showTelegram = Boolean(widget?.configured || widget?.enabled);
  const widgetReady =
    Boolean(widget?.enabled) && isValidTelegramBotUsername(widget?.bot_username);
  const telegramError = telegramErrorMessage(widget?.error, t);

  useEffect(() => {
    if (!widgetReady || !widget?.bot_username) return;
    window.onTelegramLogin = async (user: TelegramUser) => {
      setTgLoading(true);
      try {
        const data = await api<{
          token: string;
          role?: string;
          username?: string;
          must_change_password?: boolean;
        }>("/api/auth/login/telegram", {
          method: "POST",
          body: JSON.stringify(user),
        });
        setAuthSession(
          data.token,
          (data.role as "admin" | "operator" | "viewer") ?? roleFromToken(data.token),
          data.username,
          data.must_change_password,
        );
        message.success(t("login.success"));
        postLoginRedirect();
      } catch (err) {
        message.error(err instanceof Error ? err.message : t("login.tgFailed"));
      } finally {
        setTgLoading(false);
      }
    };
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", widget.bot_username);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-radius", "8");
    script.setAttribute("data-request-access", "write");
    script.setAttribute("data-onauth", "onTelegramLogin(user)");
    const el = document.getElementById("tg-login-widget");
    if (el) {
      el.innerHTML = "";
      el.appendChild(script);
    }
    return () => {
      delete window.onTelegramLogin;
    };
  }, [widgetReady, widget?.bot_username, t]);

  useEffect(() => {
    if (!fallbackOpen || !loginSession?.session_id || loginStatus !== "pending") return;
    const poll = async () => {
      try {
        const data = await api<{
          status: "pending" | "consumed" | "expired";
          token?: string;
          role?: string;
          username?: string;
          must_change_password?: boolean;
        }>(`/api/auth/login/telegram/code/${loginSession.session_id}`);
        setLoginStatus(data.status);
        if (data.status === "consumed" && data.token) {
          setAuthSession(
            data.token,
            (data.role as "admin" | "operator" | "viewer") ?? roleFromToken(data.token),
            data.username,
            data.must_change_password,
          );
          message.success(t("login.success"));
          postLoginRedirect();
        }
      } catch {
        // ignore transient poll errors
      }
    };
    poll();
    pollRef.current = window.setInterval(poll, 2000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [fallbackOpen, loginSession?.session_id, loginStatus, t]);

  const points = [
    t("login.brandPoint1"),
    t("login.brandPoint2"),
    t("login.brandPoint3"),
  ];

  return (
    <div className="auth-gate">
      <aside className="auth-gate__brand" aria-label={t("login.brandAria")}>
        <div className="auth-gate__brand-top">
          <div className="auth-gate__logo-row">
            <OpsMateLogo size={36} />
            <div>
              <div className="auth-gate__product">OpsMate</div>
              <div className="auth-gate__domain">itops.sh</div>
            </div>
          </div>
        </div>

        <div className="auth-gate__brand-body">
          <p className="auth-gate__eyebrow">
            <span className="auth-gate__eyebrow-dot" aria-hidden />
            {t("login.brandEyebrow")}
          </p>
          <h1 className="auth-gate__headline">
            {t("login.brandTitleBefore")}
            <span className="auth-gate__headline-accent">{t("login.brandTitleAccent")}</span>
          </h1>
          <p className="auth-gate__lead">{t("login.brandLead")}</p>
          <ul className="auth-gate__points">
            {points.map((text, i) => (
              <li key={text}>
                <span className="auth-gate__point-icon" aria-hidden>
                  {i + 1}
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ul>
          <a
            className="auth-gate__desktop"
            href={`${www}/download/`}
            aria-label={t("login.desktopDownload")}
          >
            <span className="auth-gate__desktop-icon" aria-hidden>
              <DownloadOutlined />
            </span>
            <span>
              <strong>{t("login.desktopDownload")}</strong>
              <small>{t("login.desktopAvailability")}</small>
            </span>
          </a>
        </div>

        <p className="auth-gate__brand-foot">{t("login.brandFoot")}</p>
      </aside>

      <section className="auth-gate__panel">
        <div className="auth-gate__panel-bar">
          <HeaderActions />
        </div>
        <div className="auth-gate__panel-main">
          <div className="auth-gate__card">
            <h2 className="auth-gate__card-title">
              {mode === "signUp" ? t("login.signUpTitle") : t("login.signInTitle")}
            </h2>
            <p className="auth-gate__card-sub">
              {mode === "signUp" ? t("login.signUpHint") : t("login.signInHint")}
            </p>

            {logtoEnabled ? (
              <Space direction="vertical" style={{ width: "100%" }} size={0}>
                {needsTermsGate || mode === "signIn" ? (
                  <div className="auth-gate__terms">
                    {needsTermsGate ? (
                      <Checkbox
                        checked={termsAccepted}
                        onChange={(e) => setTermsAccepted(e.target.checked)}
                      >
                        <span className="auth-gate__terms-label">
                          <Trans
                            i18nKey="login.termsCheckbox"
                            components={{
                              terms: (
                                <a
                                  href={`${www}/terms.html`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                />
                              ),
                              privacy: (
                                <a
                                  href={`${www}/privacy.html`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                />
                              ),
                            }}
                          />
                        </span>
                      </Checkbox>
                    ) : (
                      <p className="auth-gate__terms-notice">
                        <Trans
                          i18nKey="login.termsNoticeSignIn"
                          components={{
                            terms: (
                              <a
                                href={`${www}/terms.html`}
                                target="_blank"
                                rel="noopener noreferrer"
                              />
                            ),
                            privacy: (
                              <a
                                href={`${www}/privacy.html`}
                                target="_blank"
                                rel="noopener noreferrer"
                              />
                            ),
                          }}
                        />
                      </p>
                    )}
                  </div>
                ) : null}
                <Button
                  type="primary"
                  size="large"
                  className="auth-gate__primary"
                  loading={logtoLoading}
                  disabled={needsTermsGate && !termsAccepted}
                  onClick={() => {
                    if (!ensureTermsAccepted() && mode === "signUp") return;
                    void startLogto(mode);
                  }}
                >
                  {mode === "signUp" ? t("login.logtoRegister") : t("login.logtoContinue")}
                </Button>
                {mode === "signIn" ? (
                  <Button
                    size="large"
                    className="auth-gate__secondary"
                    loading={logtoLoading}
                    onClick={() => switchMode("signUp")}
                  >
                    {t("login.logtoRegister")}
                  </Button>
                ) : null}
                <p className="auth-gate__switch">
                  {mode === "signUp" ? t("login.haveAccount") : t("login.noAccount")}
                  <button type="button" onClick={() => switchMode(mode === "signUp" ? "signIn" : "signUp")}>
                    {mode === "signUp" ? t("login.switchToSignIn") : t("login.switchToSignUp")}
                  </button>
                </p>
              </Space>
            ) : (
              <Alert type="info" showIcon message={t("login.logtoNotConfigured")} />
            )}

            {showTelegram ? (
              <>
                <Divider className="auth-gate__divider">{t("login.orTelegram")}</Divider>
                {telegramError ? <Alert type="error" showIcon message={telegramError} /> : null}
                {widgetReady ? (
                  isLocalDevHost() ? (
                    <Alert type="info" showIcon message={t("login.widgetLocalHint")} />
                  ) : (
                    <Alert
                      type="info"
                      showIcon
                      message={t("login.widgetDomainHint", { domain: window.location.hostname })}
                    />
                  )
                ) : !telegramError ? (
                  <Alert type="warning" showIcon message={t("login.widgetBotInvalid")} />
                ) : null}
                {widgetReady ? (
                  <div id="tg-login-widget" style={{ display: "flex", justifyContent: "center" }}>
                    {tgLoading ? <Spin /> : null}
                  </div>
                ) : null}
                <Button type="link" block onClick={() => setFallbackOpen((v) => !v)}>
                  {t("login.botFallback")}
                </Button>
                {fallbackOpen ? (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Button
                      icon={<ReloadOutlined />}
                      loading={loginLoading}
                      onClick={() => void startLoginSession()}
                      block
                    >
                      {t("login.refreshCode")}
                    </Button>
                    {loginSession?.login_command ? (
                      <Alert
                        type="info"
                        message={
                          <Space>
                            <code>{loginSession.login_command}</code>
                            <Button
                              type="text"
                              size="small"
                              icon={<CopyOutlined />}
                              onClick={() => {
                                void navigator.clipboard.writeText(loginSession.login_command ?? "");
                                message.success(t("login.copied"));
                              }}
                            />
                          </Space>
                        }
                        description={
                          <Typography.Link href={loginSession.bot_chat_url} target="_blank">
                            @{loginSession.bot_username}
                          </Typography.Link>
                        }
                      />
                    ) : null}
                    {loginStatus === "pending" ? (
                      <Typography.Text type="secondary">{t("login.waitingBot")}</Typography.Text>
                    ) : null}
                  </Space>
                ) : null}
              </>
            ) : null}

            <div className="auth-gate__footer-links">
              <a href={`${www}/`} rel="noreferrer">
                {t("login.backToWww")}
              </a>
              <a href={`${www}/terms.html`} target="_blank" rel="noopener noreferrer">
                {t("login.termsLink")}
              </a>
              <a href={`${www}/privacy.html`} target="_blank" rel="noopener noreferrer">
                {t("login.privacyLink")}
              </a>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default LoginPage;
