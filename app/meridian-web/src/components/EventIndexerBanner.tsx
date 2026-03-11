"use client";

import { useEventIndexerStatus } from "@/hooks/useAnalyticsData";

interface EventIndexerBannerProps {
  compact?: boolean;
}

/**
 * Shows a warning banner when the event indexer service is offline.
 * Use compact mode for inline placement (e.g. inside FillFeed).
 */
export function EventIndexerBanner({ compact = false }: EventIndexerBannerProps) {
  const { isOffline } = useEventIndexerStatus();

  if (!isOffline) return null;

  if (compact) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-400">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
        Event indexer offline — fill data unavailable
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
      </span>
      <div>
        <p className="text-sm font-medium text-amber-300">Event indexer offline</p>
        <p className="text-xs text-amber-400/60">
          Trade history and fill data are unavailable. On-chain positions and order placement still work.
        </p>
      </div>
    </div>
  );
}
