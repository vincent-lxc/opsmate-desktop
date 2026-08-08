import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  FULL_ENTITLEMENTS,
  fetchEntitlements,
  normalizeEntitlements,
  type Entitlements,
  type FeatureKey,
} from "../services/entitlements";
import { getToken } from "../services/auth/roles";

type EntitlementsContextValue = {
  entitlements: Entitlements;
  loading: boolean;
  hasFeature: (feature: FeatureKey) => boolean;
  refresh: () => void;
};

const EntitlementsContext = createContext<EntitlementsContextValue | null>(null);

type EntitlementsProviderProps = {
  children: ReactNode;
  /**
   * Test-only override: inject a fixed entitlements value and skip the network
   * fetch. Lets AdminShell.editions.test.tsx drive menu visibility without
   * mocking `/api/entitlements/current`.
   */
  value?: Entitlements;
};

/**
 * Provides edition entitlements to the admin shell.
 *
 * Resolution order:
 *   1. Explicit `value` prop (tests) — used verbatim, no fetch.
 *   2. No auth token (auth disabled / dev) — fail-open with FULL_ENTITLEMENTS
 *      so legacy/internal installs keep the complete menu (R17).
 *   3. Authenticated — fetch `/api/entitlements/current`; on success normalize,
 *      on any error fall back to FULL_ENTITLEMENTS (backend gates still enforce
 *      per-request, so a fetch failure must never lock the UI).
 */
export function EntitlementsProvider({
  children,
  value,
}: EntitlementsProviderProps) {
  const [entitlements, setEntitlements] = useState<Entitlements>(
    value ?? FULL_ENTITLEMENTS,
  );
  const [loading, setLoading] = useState<boolean>(!value);
  const fetchSeqRef = useRef(0);

  const load = useCallback(() => {
    // Tests inject a fixed value — never hit the network.
    if (value) {
      setEntitlements(value);
      setLoading(false);
      return;
    }
    const token = getToken();
    if (!token) {
      // Auth disabled (dev/test) or pre-login — fail open with full menu.
      setEntitlements(FULL_ENTITLEMENTS);
      setLoading(false);
      return;
    }
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    fetchEntitlements()
      .then((payload) => {
        if (seq !== fetchSeqRef.current) return;
        setEntitlements(normalizeEntitlements(payload));
      })
      .catch(() => {
        if (seq !== fetchSeqRef.current) return;
        // Fail open: backend gates remain the source of truth.
        setEntitlements(FULL_ENTITLEMENTS);
      })
      .finally(() => {
        if (seq !== fetchSeqRef.current) return;
        setLoading(false);
      });
  }, [value]);

  useEffect(() => {
    load();
  }, [load]);

  // P2 #44 —— 登录 / 邀请兑换 / 退出会改写 localStorage 中的 token 并派发
  // "opsmate:auth-session"。SPA 导航下 Provider 不重新挂载，挂载时若没有 token
  // 会停在 fail-open FULL_ENTITLEMENTS（企业级），新登录用户因此看到过宽菜单。
  // 监听该事件后主动 re-load，按真实租户套餐刷新权限。
  useEffect(() => {
    const onAuthSession = () => load();
    window.addEventListener("opsmate:auth-session", onAuthSession);
    return () => {
      window.removeEventListener("opsmate:auth-session", onAuthSession);
    };
  }, [load]);

  const hasFeature = useCallback(
    (feature: FeatureKey) => entitlements.features[feature] === true,
    [entitlements],
  );

  const refresh = useCallback(() => load(), [load]);

  const contextValue = useMemo(
    () => ({ entitlements, loading, hasFeature, refresh }),
    [entitlements, loading, hasFeature, refresh],
  );

  return (
    <EntitlementsContext.Provider value={contextValue}>
      {children}
    </EntitlementsContext.Provider>
  );
}

export function useEntitlements(): EntitlementsContextValue {
  const ctx = useContext(EntitlementsContext);
  if (!ctx) {
    throw new Error("useEntitlements must be used within EntitlementsProvider");
  }
  return ctx;
}