/**
 * Secret-free React auth bridge.
 *
 * Rust owns PKCE verifier/state, authorization code processing, OpsMate bearer
 * token, and verified subject/tenant/workspace. React may only invoke named
 * commands and receive SessionStatus (no secrets).
 */

import { invoke } from "@tauri-apps/api/core";

/** No-secret session status from `auth_session_status`. */
export type SessionStatus = {
  authenticated: boolean;
  username?: string;
  role?: string;
  reauthRequired: boolean;
};

export type AuthBeginResult = {
  started: true;
};

/** Start Logto login via system browser (Rust generates PKCE; never returns secrets). */
export const beginLogin = (): Promise<AuthBeginResult> =>
  invoke<AuthBeginResult>("auth_begin_logto");

/** Poll secret-free session status. */
export const sessionStatus = (): Promise<SessionStatus> =>
  invoke<SessionStatus>("auth_session_status");

/** Clear native session (Rust-side only). */
export const logout = (): Promise<void> => invoke<void>("auth_logout");
