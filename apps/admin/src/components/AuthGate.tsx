import { type ReactNode, useEffect, useState } from "react";
import { Spin } from "antd";
import { useLocation, Navigate } from "react-router-dom";
import { api } from "../api/client";
import { refreshSessionStatus } from "../desktop/native-auth";
import { isDesktopRuntime } from "../desktop/tauri-bridge";
import {
  clearAuthSession,
  hasActiveSession,
  mustChangePassword,
} from "../services/auth/roles";

type AuthStatus = {
  enabled: boolean;
};

type AuthGateProps = {
  children: ReactNode;
};

export function AuthGate({ children }: AuthGateProps) {
  const location = useLocation();
  const desktop = isDesktopRuntime();
  const [loading, setLoading] = useState(true);
  // Desktop product always requires a native session gate (never fail-open).
  const [authEnabled, setAuthEnabled] = useState(desktop);
  // Bump after native refresh so hasActiveSession() is re-read.
  const [, setSessionEpoch] = useState(0);

  useEffect(() => {
    if (desktop) {
      // Never call blocked /api/auth/status on desktop — use secret-free native status.
      let cancelled = false;
      void (async () => {
        try {
          await refreshSessionStatus();
        } catch {
          clearAuthSession();
        } finally {
          if (!cancelled) {
            setAuthEnabled(true);
            setSessionEpoch((n) => n + 1);
            setLoading(false);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    api<AuthStatus>("/api/auth/status")
      .then((status) => setAuthEnabled(status.enabled))
      .catch(() => setAuthEnabled(false))
      .finally(() => setLoading(false));
  }, [desktop]);

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
        <Spin size="large" />
      </div>
    );
  }

  // Browser only: when backend reports auth disabled, skip the gate.
  // Desktop never takes this fail-open path.
  if (!desktop && !authEnabled) {
    return <>{children}</>;
  }

  // Desktop: non-secret native session flag. Browser: JWT in localStorage.
  if (!hasActiveSession()) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (mustChangePassword() && !location.pathname.startsWith("/account")) {
    return <Navigate to="/account?tab=security" replace />;
  }

  return <>{children}</>;
}