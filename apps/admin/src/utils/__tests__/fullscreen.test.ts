import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exitDocumentFullscreen,
  getFullscreenElement,
  requestElementFullscreen,
} from "../fullscreen";

const originalExitFullscreen = document.exitFullscreen;
const originalFullscreenElement = Object.getOwnPropertyDescriptor(document, "fullscreenElement");

afterEach(() => {
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    value: originalExitFullscreen,
  });
  if (originalFullscreenElement) {
    Object.defineProperty(document, "fullscreenElement", originalFullscreenElement);
  } else {
    Reflect.deleteProperty(document, "fullscreenElement");
  }
  delete (document as Document & { webkitExitFullscreen?: () => void }).webkitExitFullscreen;
  delete (document as Document & { webkitFullscreenElement?: Element | null })
    .webkitFullscreenElement;
});

describe("fullscreen compatibility", () => {
  it("uses the standard exit API when available", async () => {
    const element = document.createElement("div");
    const exit = vi.fn();
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: element });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });

    await exitDocumentFullscreen();

    expect(exit).toHaveBeenCalledOnce();
  });

  it("uses WebKit-prefixed APIs in WKWebView", async () => {
    const element = document.createElement("div") as HTMLDivElement & {
      webkitRequestFullscreen?: () => void;
    };
    const request = vi.fn();
    const exit = vi.fn();
    element.webkitRequestFullscreen = request;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: undefined });
    (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement =
      element;
    (document as Document & { webkitExitFullscreen?: () => void }).webkitExitFullscreen = exit;

    expect(getFullscreenElement()).toBe(element);
    await requestElementFullscreen(element);
    await exitDocumentFullscreen();

    expect(request).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("does nothing when the runtime exposes no exit API", async () => {
    const element = document.createElement("div");
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: element });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: undefined });

    await expect(exitDocumentFullscreen()).resolves.toBeUndefined();
  });
});
