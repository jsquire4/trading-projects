"use client";

import { useState, useCallback, useEffect } from "react";

const MARKET_INIT_URL =
  process.env.NEXT_PUBLIC_MARKET_INIT_TRIGGER_URL ?? "http://localhost:4001/trigger";
const SETTLEMENT_URL =
  process.env.NEXT_PUBLIC_SETTLEMENT_TRIGGER_URL ?? "http://localhost:4002/trigger";

type Status = "idle" | "loading" | "success" | "error";
type MarketPhase = "auto" | "premarket" | "open" | "postmarket" | "closed";

interface ButtonState {
  status: Status;
  message: string;
}

const PHASE_CONFIG: { phase: MarketPhase; label: string; color: string; activeColor: string }[] = [
  { phase: "auto", label: "Auto", color: "bg-white/10 hover:bg-white/20", activeColor: "bg-violet-600 ring-2 ring-violet-400" },
  { phase: "premarket", label: "Pre-Market", color: "bg-white/10 hover:bg-amber-600/50", activeColor: "bg-amber-600 ring-2 ring-amber-400" },
  { phase: "open", label: "Market Open", color: "bg-white/10 hover:bg-emerald-600/50", activeColor: "bg-emerald-600 ring-2 ring-emerald-400" },
  { phase: "postmarket", label: "After Hours", color: "bg-white/10 hover:bg-blue-600/50", activeColor: "bg-blue-600 ring-2 ring-blue-400" },
  { phase: "closed", label: "Closed", color: "bg-white/10 hover:bg-red-600/50", activeColor: "bg-red-600 ring-2 ring-red-400" },
];

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
  const [activePhase, setActivePhase] = useState<MarketPhase>("auto");
  const [phaseLoading, setPhaseLoading] = useState(false);

  const anyLoading = openState.status === "loading" || closeState.status === "loading" || phaseLoading;

  // Fetch current market state override on mount
  useEffect(() => {
    fetch("/api/market-state")
      .then((r) => r.json())
      .then((d) => { if (d.state) setActivePhase(d.state); })
      .catch(() => {}); // silent fail
  }, []);

  const setMarketPhase = useCallback(async (phase: MarketPhase) => {
    setPhaseLoading(true);
    try {
      const res = await fetch("/api/market-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: phase }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setActivePhase(phase);
      }
    } catch {
      // silent fail
    }
    setPhaseLoading(false);
  }, []);

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
    <div className="flex flex-col gap-2.5 px-4 py-2.5 rounded-xl bg-violet-500/10 border border-violet-500/30">
      <div className="flex flex-wrap items-center gap-3">
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

      {/* Market Phase Override */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">
          Market Clock
        </span>
        {PHASE_CONFIG.map(({ phase, label, color, activeColor }) => (
          <button
            key={phase}
            onClick={() => setMarketPhase(phase)}
            disabled={phaseLoading}
            className={`px-2.5 py-1 rounded-md text-[11px] font-semibold text-white transition-all ${
              activePhase === phase ? activeColor : color
            } ${phaseLoading ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            {label}
          </button>
        ))}
      </div>
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
