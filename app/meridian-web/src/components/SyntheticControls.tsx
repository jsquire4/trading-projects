"use client";

import { useState, useCallback } from "react";

const MARKET_INIT_URL =
  process.env.NEXT_PUBLIC_MARKET_INIT_TRIGGER_URL ?? "http://localhost:4001/trigger";
const SETTLEMENT_URL =
  process.env.NEXT_PUBLIC_SETTLEMENT_TRIGGER_URL ?? "http://localhost:4002/trigger";

type Status = "idle" | "loading" | "success" | "error";

interface ButtonState {
  status: Status;
  message: string;
}

export function SyntheticControls() {
  // Only render in synthetic mode
  if (process.env.NEXT_PUBLIC_MARKET_DATA_SOURCE !== "synthetic") {
    return null;
  }

  return <SyntheticControlsInner />;
}

function SyntheticControlsInner() {
  const [openState, setOpenState] = useState<ButtonState>({ status: "idle", message: "" });
  const [closeState, setCloseState] = useState<ButtonState>({ status: "idle", message: "" });

  const anyLoading = openState.status === "loading" || closeState.status === "loading";

  const triggerOpen = useCallback(async () => {
    setOpenState({ status: "loading", message: "Creating markets..." });
    try {
      const res = await fetch(MARKET_INIT_URL, { method: "POST" });
      const data = await res.json();
      if (res.ok && data.ok) {
        const created = data.summary?.totalCreated ?? 0;
        setOpenState({ status: "success", message: `${created} markets created` });
      } else {
        setOpenState({ status: "error", message: data.error ?? `HTTP ${res.status}` });
      }
    } catch (err) {
      setOpenState({
        status: "error",
        message: err instanceof Error ? err.message : "Connection failed",
      });
    }
    // Reset after 4 seconds
    setTimeout(() => setOpenState({ status: "idle", message: "" }), 4000);
  }, []);

  const triggerClose = useCallback(async () => {
    setCloseState({ status: "loading", message: "Settling markets..." });
    try {
      const res = await fetch(SETTLEMENT_URL, { method: "POST" });
      const data = await res.json();
      if (res.ok && data.ok) {
        const settled = data.summary?.settled?.length ?? 0;
        setCloseState({ status: "success", message: `${settled} markets settled` });
      } else {
        setCloseState({ status: "error", message: data.error ?? `HTTP ${res.status}` });
      }
    } catch (err) {
      setCloseState({
        status: "error",
        message: err instanceof Error ? err.message : "Connection failed",
      });
    }
    setTimeout(() => setCloseState({ status: "idle", message: "" }), 4000);
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 rounded-xl bg-violet-500/10 border border-violet-500/30">
      <span className="text-xs font-bold text-violet-400 uppercase tracking-wider">
        Synthetic Mode
      </span>
      <span className="text-violet-500/30 select-none">|</span>

      {/* Open Market */}
      <TriggerButton
        label="Open Market"
        state={openState}
        disabled={anyLoading}
        onClick={triggerOpen}
        colorClass="bg-emerald-600 hover:bg-emerald-500"
      />

      {/* Close Market */}
      <TriggerButton
        label="Close Market"
        state={closeState}
        disabled={anyLoading}
        onClick={triggerClose}
        colorClass="bg-red-600 hover:bg-red-500"
      />
    </div>
  );
}

function TriggerButton({
  label,
  state,
  disabled,
  onClick,
  colorClass,
}: {
  label: string;
  state: ButtonState;
  disabled: boolean;
  onClick: () => void;
  colorClass: string;
}) {
  const isLoading = state.status === "loading";

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onClick}
        disabled={disabled}
        className={`px-3 py-1 rounded-lg text-xs font-semibold text-white transition-all ${
          disabled
            ? "opacity-40 cursor-not-allowed bg-white/10"
            : colorClass
        }`}
      >
        {isLoading ? "..." : label}
      </button>
      {state.message && (
        <span
          className={`text-xs ${
            state.status === "success"
              ? "text-emerald-400"
              : state.status === "error"
                ? "text-red-400"
                : "text-white/50"
          }`}
        >
          {state.message}
        </span>
      )}
    </div>
  );
}
