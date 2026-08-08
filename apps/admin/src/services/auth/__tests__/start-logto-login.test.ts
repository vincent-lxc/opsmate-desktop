import { describe, expect, it, vi } from "vitest";
import { startLogtoLogin } from "../start-logto-login";
import type { LogtoPublicConfig } from "../logto-pkce";

const config: LogtoPublicConfig = {
  enabled: true,
  endpoint: "https://logto.example",
  appId: "app-id",
  redirectUri: "https://app.example/login/logto/callback",
  postLogoutRedirectUri: "https://app.example/login",
  scopes: ["openid", "profile"],
};

describe("startLogtoLogin routing", () => {
  it("desktop invokes only native authBeginLogto (no browser PKCE / navigation)", async () => {
    const authBegin = vi.fn(async () => ({ started: true }));
    const browserBegin = vi.fn(async () => {
      throw new Error("browser beginLogtoSignIn must not run on desktop");
    });

    await startLogtoLogin(config, "signIn", {
      isDesktop: () => true,
      authBeginLogto: authBegin,
      beginLogtoSignIn: browserBegin,
    });

    expect(authBegin).toHaveBeenCalledTimes(1);
    expect(authBegin).toHaveBeenCalledWith();
    expect(browserBegin).not.toHaveBeenCalled();
  });

  it("desktop signUp still uses only native auth (no first_screen browser path)", async () => {
    const authBegin = vi.fn(async () => ({ started: true }));
    const browserBegin = vi.fn(async () => undefined);

    await startLogtoLogin(config, "signUp", {
      isDesktop: () => true,
      authBeginLogto: authBegin,
      beginLogtoSignIn: browserBegin,
    });

    expect(authBegin).toHaveBeenCalledTimes(1);
    expect(browserBegin).not.toHaveBeenCalled();
  });

  it("browser invokes only beginLogtoSignIn with config + interaction", async () => {
    const authBegin = vi.fn(async () => ({ started: true }));
    const browserBegin = vi.fn(async () => undefined);

    await startLogtoLogin(config, "signUp", {
      isDesktop: () => false,
      authBeginLogto: authBegin,
      beginLogtoSignIn: browserBegin,
    });

    expect(browserBegin).toHaveBeenCalledTimes(1);
    expect(browserBegin).toHaveBeenCalledWith(config, "signUp");
    expect(authBegin).not.toHaveBeenCalled();
  });
});
