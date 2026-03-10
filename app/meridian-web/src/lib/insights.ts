export interface Insight {
  text: string;
  sentiment: "bullish" | "bearish" | "neutral";
  urgency: "low" | "medium" | "high";
}

export interface DepthLevel {
  price: number;
  quantity: number;
}

/**
 * Interpret a binary option's delta into plain English.
 * Delta approximates the market-implied probability of finishing in the money.
 */
export function interpretDelta(
  delta: number,
  ticker: string,
  strike: number,
): Insight {
  if (delta >= 0.7) {
    return {
      text: `${ticker} closing above ${strike} looks likely — market sees high probability.`,
      sentiment: "bullish",
      urgency: "low",
    };
  }
  if (delta <= 0.3) {
    return {
      text: `${ticker} finishing above ${strike} looks unlikely — low probability right now.`,
      sentiment: "bearish",
      urgency: "low",
    };
  }
  return {
    text: `${ticker} at ${strike} is a coin flip — even odds either way.`,
    sentiment: "neutral",
    urgency: "medium",
  };
}

/**
 * Interpret gamma — how fast delta is changing.
 * High gamma means small price moves cause big swings in probability.
 */
export function interpretGamma(gamma: number, ticker: string): Insight {
  if (gamma > 0.02) {
    return {
      text: `${ticker} is very sensitive to price moves right now — volatile zone.`,
      sentiment: "neutral",
      urgency: "high",
    };
  }
  if (gamma < 0.005) {
    return {
      text: `${ticker} odds are pretty settled — small moves won't change much.`,
      sentiment: "neutral",
      urgency: "low",
    };
  }
  return {
    text: `${ticker} has moderate sensitivity to price changes.`,
    sentiment: "neutral",
    urgency: "medium",
  };
}

/**
 * Interpret the bid-ask spread in cents.
 */
export function interpretSpread(spreadCents: number): Insight {
  if (spreadCents === 0) {
    return {
      text: "Spread is locked — no spread between bid and ask.",
      sentiment: "neutral",
      urgency: "low",
    };
  }
  if (spreadCents <= 2) {
    return {
      text: "Tight spread — this market is liquid, easy to get in and out.",
      sentiment: "neutral",
      urgency: "low",
    };
  }
  if (spreadCents > 10) {
    return {
      text: "Wide spread — market is illiquid, be careful with limit orders.",
      sentiment: "neutral",
      urgency: "medium",
    };
  }
  return {
    text: "Spread is moderate — decent liquidity but watch your fills.",
    sentiment: "neutral",
    urgency: "low",
  };
}

/**
 * Interpret order book depth by comparing total bid vs ask volume.
 */
export function interpretOrderDepth(
  bids: DepthLevel[],
  asks: DepthLevel[],
): Insight {
  const bidVolume = bids.reduce((sum, b) => sum + b.quantity, 0);
  const askVolume = asks.reduce((sum, a) => sum + a.quantity, 0);
  const total = bidVolume + askVolume;

  if (total === 0) {
    return {
      text: "No orders on the book — market is empty.",
      sentiment: "neutral",
      urgency: "high",
    };
  }

  const bidRatio = bidVolume / total;

  if (bidRatio > 0.65) {
    return {
      text: "Heavy buying pressure on the bid side — bulls in control.",
      sentiment: "bullish",
      urgency: "medium",
    };
  }
  if (bidRatio < 0.35) {
    return {
      text: "Selling pressure dominates the book — bears have the edge.",
      sentiment: "bearish",
      urgency: "medium",
    };
  }
  return {
    text: "Order book is balanced — no clear directional pressure.",
    sentiment: "neutral",
    urgency: "low",
  };
}

/**
 * Interpret a trader's current position in context of P&L and time remaining.
 */
export function interpretPosition(
  _side: string,
  pnl: number,
  minutesLeft: number,
): Insight {
  const winning = pnl > 0;
  const nearExpiry = minutesLeft < 5;

  if (winning && nearExpiry) {
    return {
      text: "Almost there — your position is winning with minutes to go.",
      sentiment: "bullish",
      urgency: "high",
    };
  }
  if (winning) {
    return {
      text: "You're in the green. Hold steady or lock in gains.",
      sentiment: "bullish",
      urgency: "low",
    };
  }
  if (!winning && nearExpiry) {
    return {
      text: "Position is underwater near expiry — decision time.",
      sentiment: "bearish",
      urgency: "high",
    };
  }
  return {
    text: "Position is down but there's still time for a reversal.",
    sentiment: "bearish",
    urgency: "medium",
  };
}

/**
 * Interpret how the current price move compares to the historical distribution.
 */
export function interpretReturnDistribution(
  currentMove: number,
  sigma: number,
): Insight {
  const zScore = sigma !== 0 ? Math.abs(currentMove) / sigma : 0;

  if (zScore > 2) {
    return {
      text: "This move is unusual — well outside the normal range.",
      sentiment: "neutral",
      urgency: "high",
    };
  }
  if (zScore > 1) {
    return {
      text: "A notable move, but within the broader range of normal volatility.",
      sentiment: "neutral",
      urgency: "medium",
    };
  }
  if (zScore < 0.5) {
    return {
      text: "Totally normal move — typical for this stock.",
      sentiment: "neutral",
      urgency: "low",
    };
  }
  return {
    text: "Move is within range but getting interesting.",
    sentiment: "neutral",
    urgency: "medium",
  };
}
