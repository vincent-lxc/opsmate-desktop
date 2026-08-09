import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriInvoke = vi.hoisted(() => vi.fn());
const tauriIsTauri = vi.hoisted(() => vi.fn(() => false));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => tauriInvoke(...args),
  isTauri: () => tauriIsTauri(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
import i18n from "../../../i18n";
import enUS from "../../../locales/en-US";
import zhCN from "../../../locales/zh-CN";
import {
  buildDesktopDownloadUrl,
  buildSafeCredentialMetadataBody,
  CredentialCustodyPresentation,
  CredentialsPage,
  DEFAULT_DESKTOP_DOWNLOAD_URL,
  DESKTOP_OPEN_HREF,
  ENVIRONMENT_CLASSIFICATIONS,
  resolveDeviceCredentialState,
  type CredentialRow,
} from "../CredentialsPage";
import { isDesktopRuntime } from "../../../desktop/tauri-bridge";

const FIND = { timeout: 5000 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CLOUD_ROW: CredentialRow = {
  id: "cred-cloud",
  name: "Cloud key",
  storage_mode: "encrypted_managed",
  has_cloud_secret: true,
  scope_kind: "server",
  scope_id: "srv-1",
  fingerprint: "fp-cloud",
  last_used_at: null,
  binding_count: 1,
};

const LOCAL_ROW: CredentialRow = {
  id: "cred-local",
  name: "Local only",
  storage_mode: "encrypted_managed",
  has_cloud_secret: false,
  scope_kind: null,
  scope_id: null,
  fingerprint: "fp-local",
  last_used_at: null,
  binding_count: 0,
};

const EXTERNAL_ROW: CredentialRow = {
  id: "cred-ext",
  name: "Vault ref",
  storage_mode: "external_reference",
  has_cloud_secret: false,
  scope_kind: "global",
  scope_id: null,
  fingerprint: null,
  last_used_at: null,
  binding_count: 0,
};

let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
/** Shared with desktop cloud_request mock (Task 5: api() no longer uses fetch under Tauri). */
let currentCredentialItems: CredentialRow[] = [];

function installFetch(items: CredentialRow[]) {
  currentCredentialItems = items;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/security/credentials") && method === "GET" && !url.includes("/usage")) {
      return jsonResponse({ items, total: items.length });
    }
    if (url.includes("/usage") && method === "GET") {
      return jsonResponse({ items: [], total: 0 });
    }
    if (url.includes("/api/security/credentials/metadata") && method === "POST") {
      return jsonResponse({ id: "new", name: "x", has_cloud_secret: false }, 201);
    }
    if (url.includes("/api/security/credentials/") && method === "PATCH") {
      return jsonResponse({ ...CLOUD_ROW, name: "patched" });
    }
    if (url.includes("/test-connection") && method === "POST") {
      return jsonResponse({ ok: true, message: "ok" });
    }
    if (url.includes("/api/security/credentials/") && method === "DELETE") {
      return jsonResponse({});
    }
    return jsonResponse({ error: "not mocked", _url: url }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(
  items: CredentialRow[] = [CLOUD_ROW, LOCAL_ROW],
  opts?: {
    getDeviceState?: (id: string) => "available" | "missing" | "locked" | undefined;
  },
) {
  installFetch(items);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });

  return render(
    <MemoryRouter>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <CredentialsPage getDeviceState={opts?.getDeviceState} />
        </QueryClientProvider>
      </AntApp>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  if (queryClient) {
    await queryClient.cancelQueries();
    queryClient.clear();
  }
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("credential custody pure helpers", () => {
  it("defaults this-device state to missing in browser", () => {
    expect(resolveDeviceCredentialState(undefined)).toBe("missing");
    expect(resolveDeviceCredentialState(null)).toBe("missing");
    expect(resolveDeviceCredentialState("available")).toBe("available");
    expect(resolveDeviceCredentialState("locked")).toBe("locked");
  });

  it("builds metadata body with only safe non-secret fields", () => {
    const body = buildSafeCredentialMetadataBody({
      name: "n",
      ssh_private_key: "PEM",
      storage_mode: "simple_managed",
      has_cloud_secret: true,
      scope_kind: "server",
      scope_id: "x",
      environment_classification: "test",
    } as Record<string, unknown>);
    expect(body).toEqual({ name: "n", environment_classification: "test" });
    expect(body).not.toHaveProperty("ssh_private_key");
    expect(body).not.toHaveProperty("storage_mode");
    expect(body).not.toHaveProperty("has_cloud_secret");
    expect(body).not.toHaveProperty("scope_kind");
  });

  it("allows only backend enum environment_classification values", () => {
    expect(ENVIRONMENT_CLASSIFICATIONS).toEqual([
      "test",
      "staging",
      "production",
      "unknown",
    ]);
    for (const env of ENVIRONMENT_CLASSIFICATIONS) {
      expect(
        buildSafeCredentialMetadataBody({ name: "n", environment_classification: env }),
      ).toEqual({ name: "n", environment_classification: env });
    }
    // Arbitrary / free-text values must not be submitted
    expect(
      buildSafeCredentialMetadataBody({
        name: "n",
        environment_classification: "prod",
      }),
    ).toEqual({ name: "n" });
    expect(
      buildSafeCredentialMetadataBody({
        name: "n",
        environment_classification: "anything-else",
      }),
    ).toEqual({ name: "n" });
    expect(
      buildSafeCredentialMetadataBody({
        name: "n",
        environment_classification: " test ",
      }),
    ).toEqual({ name: "n" });
  });

  it("desktop download URL accepts only valid absolute HTTPS with non-empty host", () => {
    expect(DEFAULT_DESKTOP_DOWNLOAD_URL).toBe("https://www.itops.sh/download");
    expect(DESKTOP_OPEN_HREF).toBe("opsmate://credentials");
    expect(buildDesktopDownloadUrl(undefined)).toBe(DEFAULT_DESKTOP_DOWNLOAD_URL);
    expect(buildDesktopDownloadUrl("")).toBe(DEFAULT_DESKTOP_DOWNLOAD_URL);
    // non-HTTPS
    expect(buildDesktopDownloadUrl("http://evil.example/dl")).toBe(DEFAULT_DESKTOP_DOWNLOAD_URL);
    expect(buildDesktopDownloadUrl("ftp://files.example/dl")).toBe(DEFAULT_DESKTOP_DOWNLOAD_URL);
    expect(buildDesktopDownloadUrl("javascript:alert(1)")).toBe(DEFAULT_DESKTOP_DOWNLOAD_URL);
    // malformed / empty hostname
    expect(buildDesktopDownloadUrl("https://")).toBe(DEFAULT_DESKTOP_DOWNLOAD_URL);
    expect(buildDesktopDownloadUrl("https:///")).toBe(DEFAULT_DESKTOP_DOWNLOAD_URL);
    expect(buildDesktopDownloadUrl("not-a-url")).toBe(DEFAULT_DESKTOP_DOWNLOAD_URL);
    expect(buildDesktopDownloadUrl("//cdn.example/desktop")).toBe(DEFAULT_DESKTOP_DOWNLOAD_URL);
    // valid absolute HTTPS
    expect(buildDesktopDownloadUrl("https://cdn.example/desktop")).toBe(
      "https://cdn.example/desktop",
    );
    expect(buildDesktopDownloadUrl("  https://cdn.example/desktop  ")).toBe(
      "https://cdn.example/desktop",
    );
  });
});

describe("CredentialCustodyPresentation", () => {
  it("renders cloud yes/no and device available/missing/locked", () => {
    const { rerender, unmount } = render(
      <CredentialCustodyPresentation
        hasCloudSecret={true}
        deviceState="available"
        storageMode="encrypted_managed"
      />,
    );
    expect(screen.getByTestId("custody-cloud").textContent).toMatch(/Yes|有/);
    expect(screen.getByTestId("custody-device").textContent).toMatch(/Available|可用/);

    rerender(
      <CredentialCustodyPresentation
        hasCloudSecret={false}
        deviceState="missing"
        storageMode="encrypted_managed"
      />,
    );
    expect(screen.getByTestId("custody-cloud").textContent).toMatch(/No|无/);
    expect(screen.getByTestId("custody-device").textContent).toMatch(/Missing|缺失/);

    rerender(
      <CredentialCustodyPresentation
        hasCloudSecret={true}
        deviceState="locked"
        storageMode="encrypted_managed"
      />,
    );
    expect(screen.getByTestId("custody-device").textContent).toMatch(/Locked|已锁定/);
    unmount();
  });

  it("labels external_reference as compatibility mode", () => {
    const { unmount } = render(
      <CredentialCustodyPresentation
        hasCloudSecret={false}
        deviceState="missing"
        storageMode="external_reference"
      />,
    );
    expect(screen.getByTestId("custody-external").textContent).toMatch(/compatibility|兼容/);
    unmount();
  });
});

describe("locale coverage (en + zh)", () => {
  it("defines Chinese and English custody + CTA + desktop vault strings", () => {
    const en = enUS.security.credentials as Record<string, unknown>;
    const zh = zhCN.security.credentials as Record<string, unknown>;
    for (const root of [en, zh]) {
      const custody = root.custody as Record<string, string>;
      const cta = root.cta as Record<string, string>;
      const desktop = root.desktop as Record<string, string>;
      expect(custody.cloudYes).toBeTruthy();
      expect(custody.cloudNo).toBeTruthy();
      expect(custody.deviceAvailable).toBeTruthy();
      expect(custody.deviceMissing).toBeTruthy();
      expect(custody.deviceLocked).toBeTruthy();
      expect(custody.externalCompat).toBeTruthy();
      expect(cta.openDesktop).toBeTruthy();
      expect(cta.installDesktop).toBeTruthy();
      expect(desktop.deleteLocalConfirmTitle).toBeTruthy();
      expect(desktop.deleteLocalConfirmWithCloud).toBeTruthy();
      expect(desktop.deleteLocalConfirmNoCloud).toBeTruthy();
    }
    expect((en.custody as { cloudYes: string }).cloudYes).not.toBe(
      (zh.custody as { cloudYes: string }).cloudYes,
    );
    expect(
      (en.desktop as { deleteLocalConfirmNoCloud: string }).deleteLocalConfirmNoCloud,
    ).not.toBe(
      (zh.desktop as { deleteLocalConfirmNoCloud: string }).deleteLocalConfirmNoCloud,
    );
  });

  it("defines Chinese and English labels for all four environment classifications", () => {
    for (const root of [enUS.security.credentials, zhCN.security.credentials]) {
      const envs = (root as { environments: Record<string, string> }).environments;
      for (const key of ENVIRONMENT_CLASSIFICATIONS) {
        expect(envs[key]).toBeTruthy();
      }
    }
    expect(enUS.security.credentials.environments.test).not.toBe(
      zhCN.security.credentials.environments.test,
    );
    expect(enUS.security.credentials.environments.staging).not.toBe(
      zhCN.security.credentials.environments.staging,
    );
  });
});

describe("CredentialsPage", () => {
  it("shows two-dimension custody for has_cloud_secret true/false and device fixtures", async () => {
    const { unmount } = renderPage([CLOUD_ROW, LOCAL_ROW, EXTERNAL_ROW], {
      getDeviceState: (id) => {
        if (id === "cred-cloud") return "available";
        if (id === "cred-local") return "locked";
        return "missing";
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Cloud key")).toBeInTheDocument();
    }, FIND);
    expect(screen.getByText("Local only")).toBeInTheDocument();

    const cloudBadges = screen.getAllByTestId("custody-cloud");
    const deviceBadges = screen.getAllByTestId("custody-device");
    expect(cloudBadges.length).toBeGreaterThanOrEqual(2);
    expect(deviceBadges.length).toBeGreaterThanOrEqual(2);
    expect(cloudBadges.some((el) => /Yes|有/.test(el.textContent ?? ""))).toBe(true);
    expect(cloudBadges.some((el) => /No|无/.test(el.textContent ?? ""))).toBe(true);
    expect(deviceBadges.some((el) => /Available|可用/.test(el.textContent ?? ""))).toBe(true);
    expect(deviceBadges.some((el) => /Locked|已锁定/.test(el.textContent ?? ""))).toBe(true);
    expect(screen.getByTestId("custody-external").textContent).toMatch(/compatibility|兼容/);
    unmount();
  });

  it("renders Open and Install desktop CTAs with correct hrefs", async () => {
    const { unmount } = renderPage([]);
    await waitFor(() => {
      expect(screen.getByTestId("credentials-open-desktop")).toBeInTheDocument();
    }, FIND);
    const open = screen.getByTestId("credentials-open-desktop");
    const install = screen.getByTestId("credentials-install-desktop");
    expect(open).toHaveAttribute("href", DESKTOP_OPEN_HREF);
    expect(install).toHaveAttribute("href", DEFAULT_DESKTOP_DOWNLOAD_URL);
    expect(install.getAttribute("href")?.startsWith("https://")).toBe(true);
    unmount();
  });

  it("has no PEM textarea, passphrase, file input, or replace-secret UI", async () => {
    const { unmount } = renderPage([CLOUD_ROW]);
    await waitFor(() => {
      expect(screen.getByText("Cloud key")).toBeInTheDocument();
    }, FIND);

    expect(document.querySelector('textarea[name="ssh_private_key"]')).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByText(i18n.t("security.credentials.actions.replace"))).toBeNull();
    expect(screen.queryByText(i18n.t("security.credentials.form.privateKey"))).toBeNull();
    expect(screen.queryByText(i18n.t("security.credentials.form.passphrase"))).toBeNull();
    unmount();
  });

  it("offers test connection only for cloud-backed rows; local-only guides to desktop", async () => {
    const { unmount } = renderPage([CLOUD_ROW, LOCAL_ROW]);
    await waitFor(() => {
      expect(screen.getByTestId("credential-test-cred-cloud")).toBeInTheDocument();
    }, FIND);

    expect(screen.getByTestId("credential-test-cred-cloud")).toBeInTheDocument();
    expect(screen.queryByTestId("credential-test-cred-local")).toBeNull();
    expect(screen.getByTestId("credential-local-guide-cred-local")).toBeInTheDocument();
    unmount();
  });

  it("edit save sends only safe metadata fields (no secret/storage)", async () => {
    const { unmount } = renderPage([CLOUD_ROW]);
    await waitFor(() => {
      expect(screen.getByTestId("credential-edit-cred-cloud")).toBeInTheDocument();
    }, FIND);

    fireEvent.click(screen.getByTestId("credential-edit-cred-cloud"));

    await waitFor(() => {
      expect(screen.getByTestId("credential-name-input")).toBeInTheDocument();
    }, FIND);

    const nameInput = screen.getByTestId("credential-name-input");
    // Use native value setter so rc-field-form tracks the change
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeInputValueSetter?.call(nameInput, "Renamed");
    fireEvent.input(nameInput, { target: { value: "Renamed" } });

    const submit = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".ant-drawer-body button.ant-btn-primary"),
    ).at(-1);
    expect(submit).toBeTruthy();
    fireEvent.click(submit!);

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([input, init]) => {
        const url = typeof input === "string" ? input : String(input);
        return (
          url.includes("/api/security/credentials/cred-cloud") &&
          String(init?.method ?? "").toUpperCase() === "PATCH"
        );
      });
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(String(patchCall![1]?.body ?? "{}")) as Record<string, unknown>;
      expect(body.name).toBe("Renamed");
      expect(body).not.toHaveProperty("ssh_private_key");
      expect(body).not.toHaveProperty("ssh_key_passphrase");
      expect(body).not.toHaveProperty("storage_mode");
      expect(body).not.toHaveProperty("has_cloud_secret");
      expect(body).not.toHaveProperty("scope_kind");
      expect(body).not.toHaveProperty("scope_id");
    }, FIND);
    unmount();
  });

  it("create uses metadata endpoint, not legacy secret POST", async () => {
    const { unmount } = renderPage([]);
    await waitFor(() => {
      expect(screen.getByTestId("credentials-add")).toBeInTheDocument();
    }, FIND);

    fireEvent.click(screen.getByTestId("credentials-add"));

    await waitFor(() => {
      expect(screen.getByTestId("credential-name-input")).toBeInTheDocument();
    }, FIND);

    const nameInput = screen.getByTestId("credential-name-input");
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeInputValueSetter?.call(nameInput, "Meta only");
    fireEvent.input(nameInput, { target: { value: "Meta only" } });

    const submit = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".ant-drawer-body button.ant-btn-primary"),
    ).at(-1);
    fireEvent.click(submit!);

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([input, init]) => {
        const url = typeof input === "string" ? input : String(input);
        return (
          url.includes("/credentials/metadata") &&
          String(init?.method ?? "").toUpperCase() === "POST"
        );
      });
      expect(createCall).toBeTruthy();
      const body = JSON.parse(String(createCall![1]?.body ?? "{}")) as Record<string, unknown>;
      expect(body.name).toBe("Meta only");
      expect(body).not.toHaveProperty("ssh_private_key");
      expect(body).not.toHaveProperty("storage_mode");
      if (body.environment_classification != null) {
        expect(ENVIRONMENT_CLASSIFICATIONS).toContain(body.environment_classification);
      }

      const legacySecretPost = fetchMock.mock.calls.find(([input, init]) => {
        const url = typeof input === "string" ? input : String(input);
        const method = String(init?.method ?? "GET").toUpperCase();
        return (
          method === "POST" &&
          /\/api\/security\/credentials\/?$/.test(url.replace(/\?.*$/, "")) &&
          !url.includes("/metadata")
        );
      });
      expect(legacySecretPost).toBeUndefined();
    }, FIND);
    unmount();
  });

  it("environment classification select exposes exactly the four allowed options", async () => {
    const { unmount } = renderPage([]);
    await waitFor(() => {
      expect(screen.getByTestId("credentials-add")).toBeInTheDocument();
    }, FIND);

    fireEvent.click(screen.getByTestId("credentials-add"));

    await waitFor(() => {
      expect(screen.getByTestId("credential-env-select")).toBeInTheDocument();
    }, FIND);

    // Open Ant Design Select dropdown (combobox click)
    const select = screen.getByTestId("credential-env-select");
    fireEvent.mouseDown(select.querySelector(".ant-select-selector") ?? select);

    await waitFor(() => {
      const options = document.querySelectorAll(".ant-select-item-option");
      expect(options.length).toBe(ENVIRONMENT_CLASSIFICATIONS.length);
    }, FIND);

    const optionValues = Array.from(
      document.querySelectorAll(".ant-select-item-option"),
    ).map((el) => el.getAttribute("title") || el.textContent || "");

    // Labels present for each classification (en locale)
    for (const key of ENVIRONMENT_CLASSIFICATIONS) {
      const label = i18n.t(`security.credentials.environments.${key}`);
      expect(optionValues.some((t) => t.includes(label))).toBe(true);
    }

    // Free-text field must not exist for environment classification
    expect(document.querySelector('input[name="environment_classification"][type="text"]')).toBeNull();
    expect(document.querySelector('textarea[name="environment_classification"]')).toBeNull();

    unmount();
  });
});


describe("CredentialsPage desktop vault bridge", () => {
  let invoke: ReturnType<typeof vi.fn>;
  let vaultState: { unlocked: boolean; lockedReason: string | null };
  let metaItems: Array<{ credentialId: string; fingerprint: string; devicePresent: boolean }>;

  function installVaultIpc() {
    invoke = vi.fn(
      async (
        cmd: string,
        args?: {
          req?: {
            credentialId?: string;
            method?: string;
            path?: string;
            body?: unknown;
            locale?: string | null;
          };
        },
      ) => {
        if (cmd === "cloud_request") {
          // Task 5: desktop api() → native broker (no fetch).
          const method = String(args?.req?.method ?? "GET").toUpperCase();
          const path = String(args?.req?.path ?? "");
          if (
            method === "GET" &&
            path.includes("/api/security/credentials") &&
            !path.includes("/usage")
          ) {
            return {
              status: 200,
              body: {
                items: currentCredentialItems,
                total: currentCredentialItems.length,
              },
            };
          }
          if (method === "GET" && path.includes("/usage")) {
            return { status: 200, body: { items: [], total: 0 } };
          }
          if (method === "POST" && path.includes("/metadata")) {
            return {
              status: 201,
              body: { id: "new", name: "x", has_cloud_secret: false },
            };
          }
          if (method === "PATCH" && path.includes("/api/security/credentials/")) {
            return { status: 200, body: { ...CLOUD_ROW, name: "patched" } };
          }
          if (method === "POST" && path.includes("/test-connection")) {
            return { status: 200, body: { ok: true, message: "ok" } };
          }
          if (
            method === "DELETE" &&
            path.startsWith("/api/security/credentials/")
          ) {
            return { status: 200, body: {} };
          }
          return { status: 404, body: { error: "not mocked", path } };
        }
        if (cmd === "vault_status") return { ...vaultState };
        if (cmd === "vault_list_meta") return metaItems.map((m) => ({ ...m }));
        if (cmd === "vault_init") {
          vaultState = { unlocked: true, lockedReason: null };
          return { ...vaultState };
        }
        if (cmd === "vault_unlock") {
          vaultState = { unlocked: true, lockedReason: null };
          return { ...vaultState };
        }
        if (cmd === "vault_lock") {
          vaultState = { unlocked: false, lockedReason: "locked" };
          metaItems = [];
          return { ...vaultState };
        }
        if (cmd === "vault_reset") {
          vaultState = { unlocked: false, lockedReason: "not_initialized" };
          metaItems = [];
          return { ...vaultState };
        }
        if (cmd === "vault_import") {
          const id = args?.req?.credentialId ?? "";
          metaItems = [
            ...metaItems.filter((m) => m.credentialId !== id),
            { credentialId: id, fingerprint: "fp-new", devicePresent: true },
          ];
          return { credentialId: id, fingerprint: "fp-new" };
        }
        if (cmd === "vault_delete_local") {
          const id = args?.req?.credentialId;
          metaItems = metaItems.filter((m) => m.credentialId !== id);
          return undefined;
        }
        if (cmd === "request_cloud_upload") {
          return {
            credentialId: args?.req?.credentialId,
            custodyState: "uploaded",
            ok: true,
          };
        }
        if (cmd === "request_cloud_delete") {
          return {
            credentialId: args?.req?.credentialId,
            custodyState: "deleted",
            ok: true,
          };
        }
        throw new Error(`unexpected cmd ${cmd}`);
      },
    );
    tauriIsTauri.mockReturnValue(true);
    tauriInvoke.mockImplementation(invoke as unknown as (...args: unknown[]) => unknown);
  }

  beforeEach(() => {
    vaultState = { unlocked: true, lockedReason: null };
    metaItems = [{ credentialId: "cred-local", fingerprint: "fp", devicePresent: true }];
    installVaultIpc();
  });

  afterEach(() => {
    tauriIsTauri.mockReturnValue(false);
    tauriInvoke.mockReset();
  });

  it("browser fallback: no vault panel without desktop runtime", async () => {
    tauriIsTauri.mockReturnValue(false);
    const { unmount } = renderPage([LOCAL_ROW]);
    await waitFor(() => {
      expect(screen.getByText("Local only")).toBeInTheDocument();
    }, FIND);
    expect(screen.queryByTestId("credentials-vault-panel")).toBeNull();
    expect(screen.getByTestId("credentials-browser-hint")).toBeInTheDocument();
    expect(screen.getByTestId("credential-local-guide-cred-local")).toBeInTheDocument();
    unmount();
  });

  it("desktop: loads vault_status + vault_list_meta and shows device available from meta", async () => {
    expect(isDesktopRuntime()).toBe(true);
    const { unmount, container } = renderPage([LOCAL_ROW, CLOUD_ROW]);
    expect(container.querySelector('[data-testid="credentials-vault-panel"]')).not.toBeNull();
    expect(screen.getByTestId("credentials-desktop-hint")).toBeInTheDocument();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("vault_status", {});
    }, FIND);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("vault_list_meta", {});
    }, FIND);
    await waitFor(() => {
      expect(screen.getByTestId("credentials-vault-lock")).toBeInTheDocument();
    }, FIND);
    await waitFor(() => {
      const devices = screen.getAllByTestId("custody-device");
      expect(devices.some((el) => /Available|可用/.test(el.textContent ?? ""))).toBe(true);
    }, FIND);
    // Device actions are driven by vault_list_meta, not getDeviceState injection.
    await waitFor(() => {
      expect(screen.getByTestId("credential-delete-local-cred-local")).toBeInTheDocument();
      expect(screen.getByTestId("credential-upload-cloud-cred-local")).toBeInTheDocument();
    }, FIND);
    expect(screen.queryByTestId("credential-import-local-cred-local")).toBeNull();
    unmount();
  });

  it("desktop vault_init / vault_unlock / vault_lock IPC shape and status refresh", async () => {
    vaultState = { unlocked: false, lockedReason: "not_initialized" };
    metaItems = [];
    installVaultIpc();

    const { unmount } = renderPage([LOCAL_ROW]);
    await waitFor(() => {
      expect(screen.getByTestId("credentials-vault-init")).toBeInTheDocument();
    }, FIND);

    fireEvent.click(screen.getByTestId("credentials-vault-init"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("vault_init", {});
    }, FIND);
    await waitFor(() => {
      expect(screen.getByTestId("credentials-vault-lock")).toBeInTheDocument();
    }, FIND);

    fireEvent.click(screen.getByTestId("credentials-vault-lock"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("vault_lock", {});
    }, FIND);
    await waitFor(() => {
      expect(screen.getByTestId("credentials-vault-unlock")).toBeInTheDocument();
    }, FIND);
    expect(screen.queryByTestId("credentials-vault-lock")).toBeNull();

    fireEvent.click(screen.getByTestId("credentials-vault-unlock"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("vault_unlock", {});
    }, FIND);
    await waitFor(() => {
      expect(screen.getByTestId("credentials-vault-lock")).toBeInTheDocument();
    }, FIND);

    for (const cmd of ["vault_init", "vault_unlock", "vault_lock"] as const) {
      const call = invoke.mock.calls.find((c) => c[0] === cmd);
      expect(call?.[1]).toEqual({});
    }
    unmount();
  });

  it("requires a warning confirmation before requesting native vault reset", async () => {
    vaultState = { unlocked: false, lockedReason: "locked" };
    metaItems = [];
    installVaultIpc();

    const { unmount } = renderPage([LOCAL_ROW]);
    const reset = await screen.findByTestId("credentials-vault-reset", {}, FIND);
    fireEvent.click(reset);

    expect(
      await screen.findByText(/permanently deletes all local private keys/i, {}, FIND),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /continue to native confirmation/i }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("vault_reset", {});
    }, FIND);
    await waitFor(() => {
      expect(screen.getByTestId("credentials-vault-init")).toBeInTheDocument();
    }, FIND);
    expect(invoke).not.toHaveBeenCalledWith("request_cloud_delete", expect.anything());
    unmount();
  });

  it("desktop row actions from vault_list_meta: upload/import/delete-cloud IPC shapes", async () => {
    // cred-local present on device; cred-cloud missing locally but has cloud copy.
    metaItems = [{ credentialId: "cred-local", fingerprint: "fp", devicePresent: true }];
    installVaultIpc();

    const { unmount } = renderPage([LOCAL_ROW, CLOUD_ROW]);

    await waitFor(() => {
      expect(screen.getByTestId("credential-upload-cloud-cred-local")).toBeInTheDocument();
    }, FIND);
    expect(screen.getByTestId("credential-delete-local-cred-local")).toBeInTheDocument();
    expect(screen.queryByTestId("credential-import-local-cred-local")).toBeNull();
    expect(screen.getByTestId("credential-import-local-cred-cloud")).toBeInTheDocument();
    expect(screen.getByTestId("credential-delete-cloud-cred-cloud")).toBeInTheDocument();
    expect(screen.queryByTestId("credential-upload-cloud-cred-cloud")).toBeNull();

    fireEvent.click(screen.getByTestId("credential-upload-cloud-cred-local"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("request_cloud_upload", {
        req: { credentialId: "cred-local" },
      });
    }, FIND);

    await waitFor(() => {
      const btn = screen.getByTestId("credential-import-local-cred-cloud");
      expect(btn).not.toBeDisabled();
    }, FIND);
    fireEvent.click(screen.getByTestId("credential-import-local-cred-cloud"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("vault_import", {
        req: { credentialId: "cred-cloud" },
      });
    }, FIND);
    // After import, list_meta refresh flips cloud row to available → delete-local appears.
    await waitFor(() => {
      expect(screen.getByTestId("credential-delete-local-cred-cloud")).toBeInTheDocument();
    }, FIND);
    expect(screen.queryByTestId("credential-import-local-cred-cloud")).toBeNull();

    fireEvent.click(screen.getByTestId("credential-delete-cloud-cred-cloud"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("request_cloud_delete", {
        req: { credentialId: "cred-cloud" },
      });
    }, FIND);

    for (const call of invoke.mock.calls) {
      const payload = JSON.stringify(call[1] ?? {});
      expect(payload).not.toMatch(/pem|BEGIN|passphrase/i);
    }
    unmount();
  });

  it("vault_delete_local requires confirm; cancel never invokes; confirm uses req shape and refreshes", async () => {
    metaItems = [{ credentialId: "cred-local", fingerprint: "fp", devicePresent: true }];
    installVaultIpc();

    const { unmount } = renderPage([LOCAL_ROW]);
    const deleteBtn = await screen.findByTestId("credential-delete-local-cred-local", {}, FIND);

    // Cancel path: open Popconfirm, cancel — vault_delete_local must not run.
    fireEvent.click(deleteBtn);
    const cancelBtn = await screen.findByTestId(
      "credential-delete-local-cancel-cred-local",
      {},
      FIND,
    );
    fireEvent.click(cancelBtn);
    expect(invoke.mock.calls.some((c) => c[0] === "vault_delete_local")).toBe(false);

    // Confirm path (re-open).
    fireEvent.click(await screen.findByTestId("credential-delete-local-cred-local", {}, FIND));
    const okBtn = await screen.findByTestId("credential-delete-local-ok-cred-local", {}, FIND);
    // No-cloud warning copy is shown in Popconfirm description.
    expect(document.body.textContent).toMatch(/no cloud copy|无云端副本/i);
    fireEvent.click(okBtn);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("vault_delete_local", {
        req: { credentialId: "cred-local" },
      });
    }, FIND);
    // Refresh from list_meta → local device missing → import shown, delete-local gone.
    await waitFor(() => {
      expect(screen.queryByTestId("credential-delete-local-cred-local")).toBeNull();
      expect(screen.getByTestId("credential-import-local-cred-local")).toBeInTheDocument();
    }, FIND);
    unmount();
  });
});
