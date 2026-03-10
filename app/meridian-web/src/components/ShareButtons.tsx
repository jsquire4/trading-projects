"use client";

import { buildXShareUrl, buildLinkedInShareUrl } from "@/lib/share";

interface ShareButtonsProps {
  ticker: string;
  side: string;
  payout?: number;
  marketUrl: string;
}

export function ShareButtons({ ticker, side, payout, marketUrl }: ShareButtonsProps) {
  const xUrl = buildXShareUrl(ticker, side, payout ?? 0);
  const liUrl = buildLinkedInShareUrl(
    `Trading ${side} on ${ticker} on Meridian — binary stock outcomes on Solana!`,
    marketUrl,
  );

  return (
    <div className="flex items-center gap-2">
      <a
        href={xUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="px-3 py-1.5 rounded-md border border-white/10 hover:border-white/20 text-xs text-white/50 hover:text-white/70 transition-colors"
        title="Share on X"
      >
        Share on 𝕏
      </a>
      <a
        href={liUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="px-3 py-1.5 rounded-md border border-white/10 hover:border-white/20 text-xs text-white/50 hover:text-white/70 transition-colors"
        title="Share on LinkedIn"
      >
        Share on LinkedIn
      </a>
    </div>
  );
}
