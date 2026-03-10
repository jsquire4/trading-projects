/**
 * Shared chart styling and theme constants for Recharts.
 *
 * All analytics components import from here to maintain visual consistency.
 */

// ---------------------------------------------------------------------------
// Color palette
// ---------------------------------------------------------------------------

export const COLORS = {
  /** Yes/bullish/positive signals */
  yes: "#22c55e",
  /** No/bearish/negative signals */
  no: "#ef4444",
  /** Neutral/reference */
  neutral: "#6b7280",
  /** Primary accent */
  accent: "#3b82f6",
  /** Secondary accent */
  secondary: "#a855f7",
  /** Grid and axis lines */
  grid: "rgba(255, 255, 255, 0.08)",
  /** Axis text */
  axisText: "rgba(255, 255, 255, 0.5)",
  /** Tooltip background */
  tooltipBg: "#1f2937",
  /** Tooltip border */
  tooltipBorder: "rgba(255, 255, 255, 0.1)",
  /** Chart background */
  chartBg: "transparent",
} as const;

// Categorical palette for multi-series charts
export const SERIES_COLORS = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#ef4444", // red
  "#a855f7", // purple
  "#f59e0b", // amber
  "#06b6d4", // cyan
  "#ec4899", // pink
] as const;

// ---------------------------------------------------------------------------
// Shared component props
// ---------------------------------------------------------------------------

export const AXIS_STYLE = {
  fontSize: 11,
  fill: COLORS.axisText,
  fontFamily: "ui-monospace, monospace",
} as const;

export const GRID_STYLE = {
  strokeDasharray: "3 3",
  stroke: COLORS.grid,
} as const;

export const TOOLTIP_STYLE = {
  contentStyle: {
    backgroundColor: COLORS.tooltipBg,
    border: `1px solid ${COLORS.tooltipBorder}`,
    borderRadius: "8px",
    fontSize: "12px",
    color: "white",
  },
  itemStyle: { color: "white" },
  labelStyle: { color: COLORS.axisText, marginBottom: "4px" },
} as const;

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatDollar(value: number): string {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatCompact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(2);
}
