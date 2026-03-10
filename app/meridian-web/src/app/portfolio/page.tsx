"use client";

import { useState } from "react";

// ---------------------------------------------------------------------------
// Tab types
// ---------------------------------------------------------------------------

type Tab = "positions" | "history";

// ---------------------------------------------------------------------------
// Positions tab (stub — wallet integration later)
// ---------------------------------------------------------------------------

function PositionsTab() {
  return (
    <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-12 text-center">
      <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-gradient-to-br from-green-500/20 via-blue-500/20 to-purple-500/20 border border-white/10 flex items-center justify-center text-2xl">
        💼
      </div>
      <p className="text-white/50 text-sm mb-1">No positions yet</p>
      <p className="text-white/30 text-xs">
        Connect your wallet and place trades to see your active positions here.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History tab (stub — event indexer integration later)
// ---------------------------------------------------------------------------

function HistoryTab() {
  return (
    <div className="rounded-xl bg-white/5 border border-white/10 px-6 py-12 text-center">
      <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-gradient-to-br from-green-500/20 via-blue-500/20 to-purple-500/20 border border-white/10 flex items-center justify-center text-2xl">
        📜
      </div>
      <p className="text-white/50 text-sm mb-1">No trade history</p>
      <p className="text-white/30 text-xs">
        Your executed trades, settlements, and redemptions will appear here.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PortfolioPage() {
  const [tab, setTab] = useState<Tab>("positions");

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gradient mb-1">Portfolio</h1>
        <p className="text-white/50 text-sm">
          Your positions, trade history, and settlement payouts.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/5 rounded-lg p-1 w-fit">
        {([
          { key: "positions" as Tab, label: "Positions" },
          { key: "history" as Tab, label: "History" },
        ]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
              tab === key
                ? "bg-white/10 text-white shadow-[0_2px_0_0_rgba(59,130,246,0.5)]"
                : "text-white/40 hover:text-white/70"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "positions" ? <PositionsTab /> : <HistoryTab />}
    </div>
  );
}
