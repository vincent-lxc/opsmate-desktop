import { useCallback, useEffect, useRef, useState } from "react";
import {
  canUseElementFullscreen,
  exitDocumentFullscreen,
  FULLSCREEN_CHANGE_EVENTS,
  getFullscreenElement,
  requestElementFullscreen,
} from "../utils/fullscreen";

export function useElementFullscreen(onChange?: (active: boolean) => void) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = getFullscreenElement() === rootRef.current;
      setIsFullscreen(active);
      onChange?.(active);
    };

    FULLSCREEN_CHANGE_EVENTS.forEach((event) =>
      document.addEventListener(event, handleFullscreenChange),
    );
    return () =>
      FULLSCREEN_CHANGE_EVENTS.forEach((event) =>
        document.removeEventListener(event, handleFullscreenChange),
      );
  }, [onChange]);

  const enterFullscreen = useCallback(async () => {
    const el = rootRef.current;
    if (!el || getFullscreenElement() === el) return;
    await requestElementFullscreen(el);
  }, []);

  const exitFullscreen = useCallback(async () => {
    await exitDocumentFullscreen();
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (getFullscreenElement() === rootRef.current) {
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
    supported: canUseElementFullscreen(rootRef.current),
  };
}
