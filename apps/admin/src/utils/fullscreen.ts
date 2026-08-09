type WebkitFullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type WebkitFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

export const FULLSCREEN_CHANGE_EVENTS = ["fullscreenchange", "webkitfullscreenchange"] as const;

export function getFullscreenElement(doc: Document = document): Element | null {
  return doc.fullscreenElement ?? (doc as WebkitFullscreenDocument).webkitFullscreenElement ?? null;
}

export function canUseElementFullscreen(element?: HTMLElement | null): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as WebkitFullscreenDocument;
  const prototype = typeof HTMLElement === "undefined" ? undefined : HTMLElement.prototype;
  const candidate = (element ?? prototype) as WebkitFullscreenElement | undefined;
  const canEnter =
    typeof candidate?.requestFullscreen === "function" ||
    typeof candidate?.webkitRequestFullscreen === "function";
  const canExit =
    typeof document.exitFullscreen === "function" || typeof doc.webkitExitFullscreen === "function";
  return canEnter && canExit;
}

export async function requestElementFullscreen(element: HTMLElement): Promise<void> {
  const candidate = element as WebkitFullscreenElement;
  const request = candidate.requestFullscreen ?? candidate.webkitRequestFullscreen;
  if (typeof request !== "function") return;
  await request.call(element);
}

export async function exitDocumentFullscreen(doc: Document = document): Promise<void> {
  if (!getFullscreenElement(doc)) return;
  const candidate = doc as WebkitFullscreenDocument;
  const exit = candidate.exitFullscreen ?? candidate.webkitExitFullscreen;
  if (typeof exit !== "function") return;
  await exit.call(doc);
}
