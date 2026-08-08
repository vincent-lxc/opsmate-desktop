import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDesktopAuthDeepLink,
  DesktopLogtoBridgePage,
} from "../DesktopLogtoBridgePage";

function parseDeepLink(link: string): URLSearchParams {
  expect(link.startsWith("opsmate://auth/callback?")).toBe(true);
  return new URLSearchParams(link.slice("opsmate://auth/callback?".length));
}

describe("buildDesktopAuthDeepLink", () => {
  it("forwards non-empty code and state with correct encoding", () => {
    const link = buildDesktopAuthDeepLink(
      "?code=a%2Fb&state=s%20pace&extra=drop",
    );
    const q = parseDeepLink(link);
    expect(q.get("code")).toBe("a/b");
    expect(q.get("state")).toBe("s pace");
    expect(q.get("error")).toBeNull();
    expect(q.get("error_description")).toBeNull();
    expect(q.has("extra")).toBe(false);
    // re-encode via URLSearchParams (space as + or %20 is fine)
    expect(link).toMatch(/code=a(%2F|%2f)b/);
    expect(link).toMatch(/state=s(\+|%20)pace/);
  });

  it("forwards OAuth error with optional state and error_description", () => {
    const link = buildDesktopAuthDeepLink(
      "?error=access_denied&error_description=user%20cancelled&state=s1",
    );
    const q = parseDeepLink(link);
    expect(q.get("error")).toBe("access_denied");
    expect(q.get("error_description")).toBe("user cancelled");
    expect(q.get("state")).toBe("s1");
    expect(q.get("code")).toBeNull();
  });

  it("forwards OAuth error without state", () => {
    const link = buildDesktopAuthDeepLink("?error=access_denied");
    const q = parseDeepLink(link);
    expect(q.get("error")).toBe("access_denied");
    expect(q.get("state")).toBeNull();
    expect(q.get("code")).toBeNull();
  });

  it("code without state is invalid_request and does not forward code", () => {
    const link = buildDesktopAuthDeepLink("?code=only-code");
    const q = parseDeepLink(link);
    expect(q.get("code")).toBeNull();
    expect(q.get("error")).toBe("invalid_request");
    expect(q.get("error_description")).toBe("missing_code_or_state");
  });

  it("empty code or empty state is not a success", () => {
    for (const search of [
      "?code=&state=s",
      "?code=c&state=",
      "?code=&state=",
      "?code=   &state=s",
    ]) {
      const q = parseDeepLink(buildDesktopAuthDeepLink(search));
      expect(q.get("code")).toBeNull();
      expect(q.get("error")).toBe("invalid_request");
    }
  });

  it("code+error ambiguity is safe invalid_request with no code and no attacker error_description", () => {
    const link = buildDesktopAuthDeepLink(
      "?code=evil&error=access_denied&error_description=attacker_controlled&state=s1",
    );
    const q = parseDeepLink(link);
    expect(q.get("code")).toBeNull();
    expect(q.get("error")).toBe("invalid_request");
    expect(q.get("error_description")).not.toBe("attacker_controlled");
    expect(q.get("error_description")).toBe("ambiguous_code_and_error");
    // state may be forwarded for correlation; attacker error fields must not
    expect(link).not.toContain("attacker_controlled");
    expect(link).not.toContain("code=evil");
  });

  it("error_description alone is malformed", () => {
    const link = buildDesktopAuthDeepLink(
      "?error_description=only_desc&state=s1",
    );
    const q = parseDeepLink(link);
    expect(q.get("code")).toBeNull();
    expect(q.get("error")).toBe("invalid_request");
    expect(q.get("error_description")).not.toBe("only_desc");
  });

  it("malformed empty query becomes a safe error without code", () => {
    const link = buildDesktopAuthDeepLink("?foo=bar");
    const q = parseDeepLink(link);
    expect(q.get("code")).toBeNull();
    expect(q.get("error")).toBe("invalid_request");
    expect(q.get("error_description")).toBe("missing_code_or_error");
    expect(q.has("foo")).toBe(false);
  });

  it("does not include unrelated or attacker-controlled fields", () => {
    const link = buildDesktopAuthDeepLink(
      "?code=x&state=y&token=leak&ssh_private_key=pem&redirect_uri=evil",
    );
    expect(link).not.toContain("token=");
    expect(link).not.toContain("ssh_private_key");
    expect(link).not.toContain("pem");
    expect(link).not.toContain("redirect_uri");
    const q = parseDeepLink(link);
    expect(q.get("code")).toBe("x");
    expect(q.get("state")).toBe("y");
    expect([...q.keys()].sort()).toEqual(["code", "state"]);
  });
});

describe("DesktopLogtoBridgePage", () => {
  const originalLocation = window.location;
  let replaceMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    replaceMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        search: "?code=a&state=b",
        replace: replaceMock,
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("immediately location.replace to opsmate://auth/callback with code and state", () => {
    render(<DesktopLogtoBridgePage />);
    expect(replaceMock).toHaveBeenCalledTimes(1);
    const target = String(replaceMock.mock.calls[0]![0]);
    expect(target).toContain("opsmate://auth/callback?");
    expect(target).toContain("code=a");
    expect(target).toContain("state=b");
  });

  it("forwards error query to deep link", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        search: "?error=access_denied&error_description=nope",
        replace: replaceMock,
      },
    });
    render(<DesktopLogtoBridgePage />);
    const target = String(replaceMock.mock.calls[0]![0]);
    expect(target).toContain("error=access_denied");
    expect(target).toContain("error_description=nope");
  });
});
