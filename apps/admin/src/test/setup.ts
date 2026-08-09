/**
 * Vitest global setup for the admin frontend.
 *
 * - Registers @testing-library/jest-dom matchers (toBeInTheDocument, etc.).
 * - Stubs HTMLCanvasElement.getContext so @antv/g-based chart libraries
 *   (@ant-design/charts → @ant-design/plots → @antv/g2) can mount under jsdom
 *   without a real WebGL/2D context. This is the compatibility gate for the
 *   chart wrapper foundation (unit U1): if this stub ever stops letting a
 *   <Line/> mount, U6/U10/U11 must be updated before shipping.
 *
 * The stub returns a Proxy that no-ops any method access and reports fake
 * 2d context metrics so chart init code that probes capabilities does not
 * throw. We intentionally keep this broad: chart libs evolve, and a tight
 * hand-rolled mock breaks on every @antv/g upgrade.
 */
import "@testing-library/jest-dom/vitest";

// jsdom does not implement ResizeObserver or window.matchMedia, both of which
// antd v6 + @ant-design/pro-components touch during mount (responsive observer,
// rc-table column-width measurement, pro-table virtual sizing). A purely no-op
// ResizeObserver never delivers the initial measurement, so rc-table's layout
// effect never resolves and the component never commits — pro-table pages then
// hang ~minutes under jsdom. Fire one synthetic entry per observe (synchronously)
// with a non-zero content rect so measurement effects settle on first paint.
class ResizeObserverStub {
  private callback: ResizeObserverCallback;
  private fired = new WeakSet<Element>();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    if (this.fired.has(target)) return;
    this.fired.add(target);
    const rect = target.getBoundingClientRect();
    const entry = {
      target,
      contentRect: {
        width: rect.width || 320,
        height: rect.height || 200,
        top: 0,
        left: 0,
        bottom: rect.height || 200,
        right: rect.width || 320,
      },
      borderBoxSize: [{ inlineSize: rect.width || 320, blockSize: rect.height || 200 }],
      contentBoxSize: [{ inlineSize: rect.width || 320, blockSize: rect.height || 200 }],
      devicePixelContentBoxSize: [
        { inlineSize: rect.width || 320, blockSize: rect.height || 200 },
      ],
    };
    try {
      this.callback([entry as unknown as ResizeObserverEntry], this);
    } catch {
      // Some consumers throw on the synthetic entry shape; ignore so mount
      // proceeds rather than crashing the whole render.
    }
  }
  unobserve(target: Element): void {
    this.fired.delete(target);
  }
  disconnect(): void {
    // WeakSet has no clear; leaving stale entries is harmless for tests.
  }
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

type CtxKind = "2d" | "webgl" | "webgl2" | "experimental-webgl" | string;

function makeNoopContext(): CanvasRenderingContext2D {
  // A Proxy lets chart code read any property or call any method without us
  // having to enumerate the full Canvas2D / WebGL surface.
  return new Proxy(
    {},
    {
      get(_target, prop) {
        // Sizes/probes that chart libs read during init.
        if (prop === "canvas") {
          return {
            width: 320,
            height: 200,
            clientWidth: 320,
            clientHeight: 200,
            getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 200, left: 0, top: 0, right: 320, bottom: 200 } as DOMRect),
            style: {},
            ownerDocument: document,
            getContext: () => makeNoopContext(),
          };
        }
        if (prop === "measureText") {
          return (text: string) => ({ width: (text?.length ?? 0) * 6 } as TextMetrics);
        }
        if (prop === "getImageData") {
          return () => ({ data: new Uint8ClampedArray(0) } as ImageData);
        }
        if (prop === "createImageData") {
          return () => ({ data: new Uint8ClampedArray(0) } as ImageData);
        }
        // Anything else: return a no-op function for call sites, or undefined.
        return typeof prop === "string" ? () => undefined : undefined;
      },
      set() {
        return true;
      },
    },
  ) as CanvasRenderingContext2D;
}

// jsdom ships a getContext that always returns null (it does not implement
// the Canvas API). @antv/g-based chart libs call getContext('2d') during mount
// and immediately invoke methods like clearRect on the result, so we MUST
// override jsdom's stub to return a no-op context. We always overwrite — the
// guard `if (!getContext)` would skip installing our stub because jsdom
// defines the method.
// The cast bypasses the lib DOM overloaded getContext signatures (2d /
// bitmaprenderer / webgl / webgl2 return different context types). We always
// return the same no-op 2D-style proxy; callers that probe WebGL capabilities
// do so via method calls the Proxy already no-ops.
HTMLCanvasElement.prototype.getContext = (function (
  this: HTMLCanvasElement,
  _contextId: CtxKind,
  _options?: unknown,
): CanvasRenderingContext2D | null {
  return makeNoopContext();
}) as typeof HTMLCanvasElement.prototype.getContext;

// Some chart libs check for OffscreenCanvas; jsdom lacks it — provide a stub.
if (typeof globalThis.OffscreenCanvas === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).OffscreenCanvas = class {
    constructor(public width = 300, public height = 150) {}
    getContext() {
      return makeNoopContext();
    }
  };
}