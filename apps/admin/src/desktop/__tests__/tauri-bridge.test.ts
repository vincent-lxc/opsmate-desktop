import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const isTauri = vi.fn(() => false);
const listen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  isTauri: () => isTauri(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listen(...args),
}));

import {
  authBeginLogto,
  buildCredentialIdReqArgs,
  CREDENTIAL_ID_REQ_COMMANDS,
  DESKTOP_IPC_COMMANDS,
  desktopInvoke,
  desktopListen,
  deviceStateFromVault,
  isAllowedDesktopCommand,
  isDesktopRuntime,
  requestCloudDelete,
  requestCloudUpload,
  vaultDeleteLocal,
  vaultImport,
  vaultInit,
  vaultListMeta,
  vaultLock,
  vaultStatus,
  vaultUnlock,
  type VaultMetaItemDto,
} from "../tauri-bridge";

describe("desktop tauri-bridge", () => {
  afterEach(() => {
    vi.clearAllMocks();
    isTauri.mockReturnValue(false);
  });

  it("isDesktopRuntime is false when isTauri() is false (browser)", () => {
    isTauri.mockReturnValue(false);
    expect(isDesktopRuntime()).toBe(false);
  });

  it("browser must not invoke — desktopInvoke throws when not desktop", async () => {
    isTauri.mockReturnValue(false);
    await expect(desktopInvoke("vault_status")).rejects.toThrow(/unavailable outside Tauri/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("whitelist allows only known vault/cloud/auth commands", () => {
    for (const cmd of DESKTOP_IPC_COMMANDS) {
      expect(isAllowedDesktopCommand(cmd)).toBe(true);
    }
    expect(isAllowedDesktopCommand("auth_begin_logto")).toBe(true);
    expect(isAllowedDesktopCommand("open_external_route")).toBe(true);
    expect(isAllowedDesktopCommand("vault_export_pem")).toBe(false);
    expect(isAllowedDesktopCommand("shell_open")).toBe(false);
    // Raw opener must stay Rust-only (no WebView plugin surface).
    expect(isAllowedDesktopCommand("plugin:opener|open_url")).toBe(false);
    expect(isAllowedDesktopCommand("open_url")).toBe(false);
  });

  it("credential-scoped commands use exact { req: { credentialId } } shape", () => {
    const args = buildCredentialIdReqArgs("cred-xyz");
    expect(args).toEqual({ req: { credentialId: "cred-xyz" } });
    expect(Object.keys(args)).toEqual(["req"]);
    expect(Object.keys(args.req)).toEqual(["credentialId"]);
    // Never secret fields
    expect(JSON.stringify(args)).not.toMatch(/pem|passphrase|privateKey|bearer/i);
    for (const cmd of CREDENTIAL_ID_REQ_COMMANDS) {
      expect(DESKTOP_IPC_COMMANDS).toContain(cmd);
    }
  });

  describe("with mocked official Tauri API", () => {
    beforeEach(() => {
      isTauri.mockReturnValue(true);
      invoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === "vault_status") {
          return { unlocked: false, lockedReason: "locked" };
        }
        if (cmd === "vault_list_meta") {
          return [
            {
              credentialId: "c1",
              fingerprint: "fp",
              devicePresent: true,
            },
          ] satisfies VaultMetaItemDto[];
        }
        if (cmd === "vault_import") {
          return { credentialId: "c1", fingerprint: "fp-new" };
        }
        if (cmd === "request_cloud_upload") {
          return { credentialId: "c1", custodyState: "uploaded", ok: true };
        }
        if (cmd === "request_cloud_delete") {
          return { credentialId: "c1", custodyState: "deleted", ok: true };
        }
        return args;
      });
    });

    it("detects desktop runtime when isTauri() is true", () => {
      expect(isDesktopRuntime()).toBe(true);
    });

    it("vault_status / init / unlock / lock pass no secret payload", async () => {
      await vaultStatus();
      await vaultInit();
      await vaultUnlock();
      await vaultLock();
      expect(invoke).toHaveBeenCalledWith("vault_status", {});
      expect(invoke).toHaveBeenCalledWith("vault_init", {});
      expect(invoke).toHaveBeenCalledWith("vault_unlock", {});
      expect(invoke).toHaveBeenCalledWith("vault_lock", {});
    });

    it("vault_list_meta returns meta items", async () => {
      const list = await vaultListMeta();
      expect(list[0]?.credentialId).toBe("c1");
      expect(invoke).toHaveBeenCalledWith("vault_list_meta", {});
    });

    it("vault_import and vault_delete_local use req.credentialId only", async () => {
      await vaultImport("cred-a");
      await vaultDeleteLocal("cred-b");
      expect(invoke).toHaveBeenCalledWith("vault_import", {
        req: { credentialId: "cred-a" },
      });
      expect(invoke).toHaveBeenCalledWith("vault_delete_local", {
        req: { credentialId: "cred-b" },
      });
      for (const call of invoke.mock.calls) {
        const payload = JSON.stringify(call[1] ?? {});
        expect(payload).not.toMatch(/pem|BEGIN|passphrase/i);
      }
    });

    it("cloud upload/delete use req.credentialId only", async () => {
      await requestCloudUpload("cred-up");
      await requestCloudDelete("cred-del");
      expect(invoke).toHaveBeenCalledWith("request_cloud_upload", {
        req: { credentialId: "cred-up" },
      });
      expect(invoke).toHaveBeenCalledWith("request_cloud_delete", {
        req: { credentialId: "cred-del" },
      });
    });

    it("authBeginLogto invokes auth_begin_logto with empty args and secret-free response", async () => {
      invoke.mockImplementationOnce(async (cmd: string) => {
        if (cmd === "auth_begin_logto") return { started: true };
        return {};
      });
      const resp = await authBeginLogto();
      expect(resp).toEqual({ started: true });
      expect(invoke).toHaveBeenCalledWith("auth_begin_logto", {});
      expect(Object.keys(resp)).toEqual(["started"]);
      expect(JSON.stringify(resp)).not.toMatch(
        /code_verifier|codeVerifier|verifier|pem|passphrase|bearer|token|privateKey/i,
      );
    });

    it("desktopListen uses official event API and never window.__TAURI__", async () => {
      const unlisten = vi.fn();
      listen.mockResolvedValueOnce(unlisten);
      const handler = vi.fn();
      const stop = await desktopListen("opsmate:local-ssh-output", handler);
      expect(listen).toHaveBeenCalled();
      expect(typeof stop).toBe("function");
      // Deliver a payload through the registered listener
      const reg = listen.mock.calls[0]?.[1] as (e: { payload: unknown }) => void;
      reg({ payload: { kind: "data" } });
      expect(handler).toHaveBeenCalledWith({ kind: "data" });
    });
  });

  it("deviceStateFromVault maps locked / available / missing", () => {
    const map = new Map<string, VaultMetaItemDto>([
      ["a", { credentialId: "a", fingerprint: "f", devicePresent: true }],
      ["b", { credentialId: "b", fingerprint: "f", devicePresent: false }],
    ]);
    expect(deviceStateFromVault(false, map, "a")).toBe("locked");
    expect(deviceStateFromVault(true, map, "a")).toBe("available");
    expect(deviceStateFromVault(true, map, "b")).toBe("missing");
    expect(deviceStateFromVault(true, map, "missing-id")).toBe("missing");
  });
});
