"use client";

import { useState, useRef, useEffect } from "react";
import type { Insight } from "@/lib/insights";

interface InsightTooltipProps {
  insight: Insight;
  children: React.ReactNode;
}

export function InsightTooltip({ insight, children }: InsightTooltipProps) {
  const [show, setShow] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Position tooltip to stay within viewport
  useEffect(() => {
    if (!show || !tooltipRef.current || !containerRef.current) return;
    const tooltip = tooltipRef.current;
    const rect = tooltip.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      tooltip.style.left = "auto";
      tooltip.style.right = "0";
    }
  }, [show]);

  const borderColor =
    insight.sentiment === "bullish"
      ? "border-green-500/40"
      : insight.sentiment === "bearish"
        ? "border-red-500/40"
        : "border-amber-500/40";

  const bgColor =
    insight.sentiment === "bullish"
      ? "bg-green-500/10"
      : insight.sentiment === "bearish"
        ? "bg-red-500/10"
        : "bg-amber-500/10";

  return (
    <div
      ref={containerRef}
      className="relative inline-flex items-center gap-1"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      <span className="text-white/20 hover:text-white/50 cursor-help text-[10px] transition-colors">
        ?
      </span>

      {show && (
        <div
          ref={tooltipRef}
          className={`absolute bottom-full left-0 mb-2 z-50 max-w-xs rounded-lg border ${borderColor} ${bgColor} backdrop-blur-sm px-3 py-2 shadow-lg`}
        >
          <p className="text-xs text-white/80 leading-relaxed">{insight.text}</p>
          {insight.urgency === "high" && (
            <span className="inline-block mt-1 text-[10px] text-amber-400 font-medium">
              Time-sensitive
            </span>
          )}
        </div>
      )}
    </div>
  );
}
