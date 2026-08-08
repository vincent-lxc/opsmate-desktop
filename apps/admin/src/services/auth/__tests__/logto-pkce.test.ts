import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginLogtoSignIn,
  buildLogtoSignOutUrl,
  consumeLogtoCallbackParams,
  type LogtoPublicConfig,
} from "../logto-pkce";

const config: LogtoPublicConfig = {
  enabled: true,
  endpoint: "http://localhost:3301",
  appId: "app_test",
  redirectUri: "http://localhost:9000/login/logto/callback",
  postLogoutRedirectUri: "http://localhost:9000/login",
  scopes: ["openid", "profile", "email"],
};

describe("logto-pkce", () => {
  const assignMock = vi.fn();

  beforeEach(() => {
    sessionStorage.clear();
    assignMock.mockReset();
    // jsdom location.assign is not always writable; stub via defineProperty
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign: assignMock },
    });
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("beginLogtoSignIn builds S256 authorize URL with redirect and scopes", async () => {
    await beginLogtoSignIn(config, "signIn");
    expect(assignMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(assignMock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("http://localhost:3301/oidc/auth");
    expect(url.searchParams.get("client_id")).toBe("app_test");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("first_screen")).toBeNull();
    expect(sessionStorage.getItem("opsmate_logto_code_verifier")).toBeTruthy();
    expect(sessionStorage.getItem("opsmate_logto_state")).toBe(url.searchParams.get("state"));
  });

  it("beginLogtoSignIn signUp sets first_screen=register", async () => {
    await beginLogtoSignIn(config, "signUp");
    const url = new URL(String(assignMock.mock.calls[0]![0]));
    expect(url.searchParams.get("first_screen")).toBe("register");
    expect(url.searchParams.get("prompt")).toBe("login");
  });

  it("buildLogtoSignOutUrl ends the Logto SSO session and returns to OpsMate", () => {
    const url = new URL(buildLogtoSignOutUrl(config));
    expect(url.origin + url.pathname).toBe("http://localhost:3301/oidc/session/end");
    expect(url.searchParams.get("client_id")).toBe("app_test");
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe(
      config.postLogoutRedirectUri,
    );
  });

  it("consumeLogtoCallbackParams returns code+verifier when state matches", async () => {
    await beginLogtoSignIn(config, "signIn");
    const authUrl = new URL(String(assignMock.mock.calls[0]![0]));
    const state = authUrl.searchParams.get("state")!;
    const result = consumeLogtoCallbackParams(`?code=abc&state=${state}`);
    expect(result.code).toBe("abc");
    expect(result.state).toBe(state);
    expect(result.codeVerifier).toBeTruthy();
    // one-shot consume
    expect(sessionStorage.getItem("opsmate_logto_code_verifier")).toBeNull();
  });

  it("consumeLogtoCallbackParams rejects state mismatch", async () => {
    await beginLogtoSignIn(config, "signIn");
    expect(() => consumeLogtoCallbackParams("?code=abc&state=wrong")).toThrow(/Invalid OAuth state/i);
  });

  it("consumeLogtoCallbackParams rejects missing verifier", () => {
    sessionStorage.setItem("opsmate_logto_state", "st");
    // no verifier
    expect(() => consumeLogtoCallbackParams("?code=abc&state=st")).toThrow(
      /Missing authorization code or PKCE verifier/i,
    );
  });

  it("consumeLogtoCallbackParams surfaces IdP error", () => {
    expect(() =>
      consumeLogtoCallbackParams("?error=access_denied&error_description=User%20cancelled"),
    ).toThrow(/User cancelled|access_denied/);
  });
});
