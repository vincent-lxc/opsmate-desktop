import { useCallback, useRef, useState } from "react";

const STORAGE_KEY = "opsmate-terminal-ai-split-pct";
const DEFAULT_SPLIT_PCT = 44;
const MIN_SPLIT_PCT = 22;
const MAX_SPLIT_PCT = 72;

function clampSplit(value: number): number {
  return Math.min(MAX_SPLIT_PCT, Math.max(MIN_SPLIT_PCT, value));
}

function readStoredSplit(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed = stored ? Number(stored) : NaN;
    return Number.isFinite(parsed) ? clampSplit(parsed) : DEFAULT_SPLIT_PCT;
  } catch {
    return DEFAULT_SPLIT_PCT;
  }
}

export function useTerminalSplitPane(onLayoutChange?: () => void) {
  const [aiSplitPct, setAiSplitPct] = useState(readStoredSplit);
  const aiSplitPctRef = useRef(aiSplitPct);
  aiSplitPctRef.current = aiSplitPct;

  const startDrag = useCallback(
    (container: HTMLElement | null) => (event: React.PointerEvent<HTMLDivElement>) => {
      if (!container) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);

      const rect = container.getBoundingClientRect();

      const handleMove = (ev: PointerEvent) => {
        const offsetY = ev.clientY - rect.top;
        const pct = clampSplit((offsetY / rect.height) * 100);
        setAiSplitPct(pct);
        onLayoutChange?.();
      };

      const handleUp = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        try {
          localStorage.setItem(STORAGE_KEY, String(aiSplitPctRef.current));
        } catch {
          // ignore quota / private mode
        }
        onLayoutChange?.();
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [onLayoutChange],
  );

  return { aiSplitPct, startDrag };
}