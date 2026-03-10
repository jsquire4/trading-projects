import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts } from "../useKeyboardShortcuts";

describe("useKeyboardShortcuts", () => {
  it("calls onYes when Y is pressed", () => {
    const onYes = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onYes }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y" }));
    expect(onYes).toHaveBeenCalledOnce();
  });

  it("calls onNo when N is pressed", () => {
    const onNo = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onNo }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
    expect(onNo).toHaveBeenCalledOnce();
  });

  it("calls onConfirm when Enter is pressed", () => {
    const onConfirm = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onConfirm }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onClose }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onIncrease on + or ArrowUp", () => {
    const onIncrease = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onIncrease }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "+" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(onIncrease).toHaveBeenCalledTimes(2);
  });

  it("calls onDecrease on - or ArrowDown", () => {
    const onDecrease = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onDecrease }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "-" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(onDecrease).toHaveBeenCalledTimes(2);
  });

  it("does not fire when target is an INPUT element", () => {
    const onYes = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onYes }));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true }));
    expect(onYes).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("does not fire when target is a TEXTAREA element", () => {
    const onYes = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onYes }));
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true }));
    expect(onYes).not.toHaveBeenCalled();
    document.body.removeChild(textarea);
  });

  it("does not fire when enabled is false", () => {
    const onYes = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onYes }, false));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y" }));
    expect(onYes).not.toHaveBeenCalled();
  });

  it("cleans up listeners on unmount", () => {
    const onYes = vi.fn();
    const { unmount } = renderHook(() => useKeyboardShortcuts({ onYes }));
    unmount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "y" }));
    expect(onYes).not.toHaveBeenCalled();
  });
});
