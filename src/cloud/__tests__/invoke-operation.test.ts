/**
 * Task 6B2B review rework: typed allowlist, error whitelist, frozen IDs, JSON input.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import invokeSource from "../invoke-operation.ts?raw";
import typesSource from "../types.ts?raw";
import generatedSource from "../generated-operations.ts?raw";

const invoke = vi.fn();
const listen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listen(...args),
}));

import * as cloudAdapter from "../invoke-operation";
import {
  invokeOperation,
  subscribeSessionInvalidated,
  isIpcCallableOperationId,
  isJsonObject,
  CloudInvokeError,
  IPC_CALLABLE_OPERATION_IDS,
  LOCAL_UNKNOWN_OPERATION,
  LOCAL_INVALID_INPUT,
  type IpcCallableOperationId,
} from "../invoke-operation";

describe("invoke-operation", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
  });

  it("invokes cloud_call with exact envelope { args: { operationId, input } }", async () => {
    invoke.mockResolvedValue({ ok: true });
    await invokeOperation("servers.list", { page: "1" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("cloud_call", {
      args: {
        operationId: "servers.list",
        input: { page: "1" },
      },
    });
    const [, payload] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(payload)).toEqual(["args"]);
    const args = payload.args as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["input", "operationId"]);
    for (const banned of [
      "url",
      "method",
      "headers",
      "bearer",
      "token",
      "authorization",
      "tenantId",
      "subject",
      "workspaceId",
    ]) {
      expect(args).not.toHaveProperty(banned);
      expect(payload).not.toHaveProperty(banned);
    }
  });

  it("defaults input to empty object", async () => {
    invoke.mockResolvedValue({});
    await invokeOperation("auth.me");
    expect(invoke).toHaveBeenCalledWith("cloud_call", {
      args: { operationId: "auth.me", input: {} },
    });
  });

  it("production signature is IpcCallableOperationId only; runtime rejects cast unknown", async () => {
    // Compile-time: invokeOperation expects IpcCallableOperationId (not string).
    const allowed: IpcCallableOperationId = "auth.me";
    invoke.mockResolvedValue({});
    await invokeOperation(allowed);

    // Defense in depth: force unknown string past the type system.
    const unknown = "auth.config" as unknown as IpcCallableOperationId;
    await expect(invokeOperation(unknown)).rejects.toMatchObject({
      name: "CloudInvokeError",
      code: LOCAL_UNKNOWN_OPERATION,
    });
    await expect(
      invokeOperation("not.a.real.op" as unknown as IpcCallableOperationId),
    ).rejects.toBeInstanceOf(CloudInvokeError);
    // Only the allowed call above should have invoked.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(isIpcCallableOperationId("auth.exchange")).toBe(false);
    expect(isIpcCallableOperationId("auth.me")).toBe(true);
  });

  it("exported operation id array is frozen and cannot be widened", () => {
    expect(Object.isFrozen(IPC_CALLABLE_OPERATION_IDS)).toBe(true);
    expect(() => {
      // @ts-expect-error frozen array is not mutable
      (IPC_CALLABLE_OPERATION_IDS as string[]).push("auth.config");
    }).toThrow();
    expect(IPC_CALLABLE_OPERATION_IDS as readonly string[]).not.toContain(
      "auth.config",
    );
    expect(isIpcCallableOperationId("auth.config")).toBe(false);
  });

  it("does not export a mutable allowlist Set", () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        cloudAdapter,
        "IPC_CALLABLE_OPERATION_ID_SET",
      ),
    ).toBe(false);
    expect(
      (cloudAdapter as Record<string, unknown>).IPC_CALLABLE_OPERATION_ID_SET,
    ).toBeUndefined();
    expect(generatedSource).not.toContain("IPC_CALLABLE_OPERATION_ID_SET");
    expect(typesSource).not.toContain("IPC_CALLABLE_OPERATION_ID_SET");
    expect(invokeSource).not.toMatch(
      /export \{[^}]*IPC_CALLABLE_OPERATION_ID_SET/,
    );
  });

  it("rejects invalid JSON business input before invoke (cycle, Date, class, etc.)", async () => {
    const cycle: Record<string, unknown> = { a: 1 };
    cycle.self = cycle;

    class Foo {
      x = 1;
    }

    const badInputs: unknown[] = [
      null,
      1,
      "x",
      true,
      [1, 2],
      new Date(),
      new Foo(),
      { d: new Date() },
      { f: () => 1 },
      { u: undefined },
      { s: Symbol("s") },
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      { b: 1n },
      cycle,
      { nested: { arr: [1, { bad: new Date() }] } },
    ];

    for (const bad of badInputs) {
      expect(isJsonObject(bad)).toBe(false);
      await expect(
        invokeOperation("auth.me", bad as never),
      ).rejects.toMatchObject({ code: LOCAL_INVALID_INPUT });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("accepts shared acyclic object references (sibling fields) and invokes once", async () => {
    invoke.mockResolvedValue({ ok: true });
    const shared = { id: "s1", n: 1 };
    const input = { left: shared, right: shared, tags: [shared, shared] };
    expect(isJsonObject(input)).toBe(true);
    await invokeOperation("servers.list", input);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects direct and indirect cycles with invalid_input and zero invoke", async () => {
    const direct: Record<string, unknown> = { a: 1 };
    direct.self = direct;

    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", next: a };
    a.next = b;

    for (const cyclic of [direct, a, { root: a }]) {
      expect(isJsonObject(cyclic)).toBe(false);
      await expect(
        invokeOperation("auth.me", cyclic as never),
      ).rejects.toMatchObject({
        name: "CloudInvokeError",
        code: LOCAL_INVALID_INPUT,
      });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects throwing getters and getPrototypeOf proxies as invalid_input", async () => {
    const throwingGetter = {};
    Object.defineProperty(throwingGetter, "secret", {
      enumerable: true,
      get() {
        throw new Error("getter boom");
      },
    });

    const throwingProto = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("proto boom");
        },
      },
    );

    for (const bad of [throwingGetter, throwingProto]) {
      expect(isJsonObject(bad)).toBe(false);
      await expect(
        invokeOperation("auth.me", bad as never),
      ).rejects.toMatchObject({
        name: "CloudInvokeError",
        code: LOCAL_INVALID_INPUT,
      });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("compile-time: non-allowlisted operation id is not accepted without cast", () => {
    // Unreachable; proves TypeScript rejects native_only / unknown ids.
    if (false as boolean) {
      // @ts-expect-error auth.config is not an IpcCallableOperationId
      void invokeOperation("auth.config");
    }
    expect(isIpcCallableOperationId("auth.config")).toBe(false);
  });

  it("accepts plain JSON objects including nested arrays of JSON values", async () => {
    invoke.mockResolvedValue({ ok: true });
    await invokeOperation("servers.list", {
      page: "1",
      tags: ["a", "b"],
      nested: { n: 1, flag: false, z: null },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("whitelists only fixed Rust public codes; secret-like short strings map to transport", async () => {
    invoke.mockRejectedValue("session_invalidated");
    await expect(invokeOperation("auth.me", {})).rejects.toMatchObject({
      code: "session_invalidated",
    });

    invoke.mockRejectedValue("cancelled");
    await expect(invokeOperation("auth.me", {})).rejects.toMatchObject({
      code: "cancelled",
    });

    // Short secret-like strings must NOT pass through.
    for (const leak of [
      "sk-live-abc",
      "tok_12",
      "Bearer x",
      "eyJhbG",
      "secret",
      "https://x",
      "a".repeat(8),
    ]) {
      invoke.mockRejectedValue(leak);
      try {
        await invokeOperation("auth.me", {});
        expect.fail("should throw");
      } catch (e) {
        expect(e).toBeInstanceOf(CloudInvokeError);
        const err = e as CloudInvokeError;
        expect(err.code).toBe("transport");
        expect(err.message).toBe("transport");
        expect(err.message).not.toContain(leak);
        expect(String(err)).not.toContain(leak);
      }
    }
  });

  it("subscribeSessionInvalidated uses exact event name, ignores payload, returns unlisten", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const cb = vi.fn();
    const stop = await subscribeSessionInvalidated(cb);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0][0]).toBe("session-invalidated");
    const handler = listen.mock.calls[0][1] as (event: unknown) => void;
    handler({ payload: { token: "LEAK", url: "https://x" } });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith();
    expect(stop).toBe(unlisten);
  });

  it("allowlist is generated ipc_via_rust only (no native_only)", () => {
    expect(IPC_CALLABLE_OPERATION_IDS).toContain("auth.me");
    expect(IPC_CALLABLE_OPERATION_IDS).toContain("servers.list");
    expect(IPC_CALLABLE_OPERATION_IDS as readonly string[]).not.toContain(
      "auth.config",
    );
    expect(IPC_CALLABLE_OPERATION_IDS as readonly string[]).not.toContain(
      "auth.exchange",
    );
    const sorted = [...IPC_CALLABLE_OPERATION_IDS].sort((a, b) =>
      a.localeCompare(b),
    );
    expect([...IPC_CALLABLE_OPERATION_IDS]).toEqual(sorted);
    expect(generatedSource).not.toContain("IpcCallableOperationIdUnion");
  });

  it("source bans fetch/storage and secret-bearing APIs", () => {
    let corpus = "";
    for (const raw of [invokeSource, typesSource, generatedSource]) {
      corpus += raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
    }
    for (const banned of [
      "fetch(",
      "XMLHttpRequest",
      "WebSocket",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "Authorization",
      "access_token",
      "refresh_token",
      "codeVerifier",
      "code_verifier",
      "console.log",
      "console.debug",
      "JSON.stringify(input)",
      "JSON.stringify(business",
    ]) {
      expect(corpus).not.toContain(banned);
    }
    expect(corpus).toContain('invoke<unknown>("cloud_call"');
    expect(corpus).toContain("session-invalidated");
    expect(corpus).not.toContain("export const IPC_CALLABLE_OPERATION_ID_SET");
  });
});
