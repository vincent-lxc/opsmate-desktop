/**
 * Route Logto sign-in start: Tauri → native auth_begin_logto (system browser +
 * native PKCE); browser → existing JS PKCE + window.location.assign.
 */
import { authBeginLogto, isDesktopRuntime } from "../../desktop/tauri-bridge";
import { beginLogtoSignIn, type LogtoPublicConfig } from "./logto-pkce";

export type AuthBeginLogtoResponse = {
  started: boolean;
};

export type StartLogtoLoginDeps = {
  isDesktop: () => boolean;
  authBeginLogto: () => Promise<AuthBeginLogtoResponse>;
  beginLogtoSignIn: (
    config: LogtoPublicConfig,
    interaction: "signIn" | "signUp",
  ) => Promise<void>;
};

const defaultDeps: StartLogtoLoginDeps = {
  isDesktop: isDesktopRuntime,
  authBeginLogto: authBeginLogto,
  beginLogtoSignIn,
};

/**
 * Start Logto login for the current runtime.
 * Desktop never runs browser PKCE or assigns window.location.
 */
export async function startLogtoLogin(
  config: LogtoPublicConfig,
  interaction: "signIn" | "signUp" = "signIn",
  deps: Partial<StartLogtoLoginDeps> = {},
): Promise<void> {
  const d: StartLogtoLoginDeps = { ...defaultDeps, ...deps };
  if (d.isDesktop()) {
    await d.authBeginLogto();
    return;
  }
  await d.beginLogtoSignIn(config, interaction);
}
