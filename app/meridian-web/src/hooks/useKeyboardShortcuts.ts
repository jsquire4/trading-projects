"use client";

import { useEffect, useCallback, useRef } from "react";

interface ShortcutHandlers {
  onYes?: () => void;
  onNo?: () => void;
  onConfirm?: () => void;
  onClose?: () => void;
  onIncrease?: () => void;
  onDecrease?: () => void;
}

export function useKeyboardShortcuts(
  handlers: ShortcutHandlers,
  enabled: boolean = true,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ignore when typing in form elements
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const h = handlersRef.current;
      switch (e.key.toLowerCase()) {
        case "y":
          h.onYes?.();
          break;
        case "n":
          h.onNo?.();
          break;
        case "enter":
          h.onConfirm?.();
          break;
        case "escape":
          h.onClose?.();
          break;
        case "+":
        case "arrowup":
          h.onIncrease?.();
          break;
        case "-":
        case "arrowdown":
          h.onDecrease?.();
          break;
      }
    },
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, handleKeyDown]);
}
