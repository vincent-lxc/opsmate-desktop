/**
 * Minimal PKCE helpers for Logto OIDC Authorization Code flow.
 * Code verifier stays in sessionStorage; backend exchanges code for OpsMate JWT.
 */

const VERIFIER_KEY = "opsmate_logto_code_verifier";
const STATE_KEY = "opsmate_logto_state";

function base64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomString(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return base64Url(arr.buffer);
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64Url(hash);
}

export type LogtoPublicConfig = {
  enabled: boolean;
  endpoint: string | null;
  appId: string | null;
  redirectUri: string;
  postLogoutRedirectUri: string;
  scopes: string[];
};

export function buildLogtoSignOutUrl(config: LogtoPublicConfig): string {
  if (!config.enabled || !config.endpoint || !config.appId) {
    throw new Error("Logto is not configured");
  }

  const url = new URL("/oidc/session/end", config.endpoint);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("post_logout_redirect_uri", config.postLogoutRedirectUri);
  return url.toString();
}

export async function beginLogtoSignIn(
  config: LogtoPublicConfig,
  interaction: "signIn" | "signUp" = "signIn",
): Promise<void> {
  if (!config.enabled || !config.endpoint || !config.appId) {
    throw new Error("Logto is not configured");
  }
  const verifier = randomString(32);
  const state = randomString(16);
  const challenge = await sha256Base64Url(verifier);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const url = new URL("/oidc/auth", config.endpoint);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (config.scopes?.length ? config.scopes : ["openid", "profile", "email"]).join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  // Logto experience: first_screen / interaction
  if (interaction === "signUp") {
    url.searchParams.set("prompt", "login");
    url.searchParams.set("first_screen", "register");
  }

  window.location.assign(url.toString());
}

export function consumeLogtoCallbackParams(search: string): {
  code: string;
  state: string;
  codeVerifier: string;
} {
  const params = new URLSearchParams(search);
  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  const err = params.get("error");
  if (err) {
    throw new Error(params.get("error_description") || err);
  }
  const expectedState = sessionStorage.getItem(STATE_KEY) ?? "";
  const codeVerifier = sessionStorage.getItem(VERIFIER_KEY) ?? "";
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!code || !codeVerifier) {
    throw new Error("Missing authorization code or PKCE verifier");
  }
  if (!state || !expectedState || state !== expectedState) {
    throw new Error("Invalid OAuth state");
  }
  return { code, state, codeVerifier };
}
