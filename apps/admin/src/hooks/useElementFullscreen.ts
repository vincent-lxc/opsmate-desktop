import { useCallback, useEffect, useRef, useState } from "react";

export function useElementFullscreen(onChange?: (active: boolean) => void) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = document.fullscreenElement === rootRef.current;
      setIsFullscreen(active);
      onChange?.(active);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [onChange]);

  const enterFullscreen = useCallback(async () => {
    const el = rootRef.current;
    if (!el || document.fullscreenElement === el) return;
    await el.requestFullscreen();
  }, []);

  const exitFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) return;
    await document.exitFullscreen();
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement === rootRef.current) {
      await exitFullscreen();
    } else {
      await enterFullscreen();
    }
  }, [enterFullscreen, exitFullscreen]);

  return {
    rootRef,
    isFullscreen,
    enterFullscreen,
    exitFullscreen,
    toggleFullscreen,
    supported: typeof document !== "undefined" && document.fullscreenEnabled,
  };
}