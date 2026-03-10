"use client";

interface PayoffDisplayProps {
  side: "yes" | "no";
  price: number; // cents (1-99)
  ticker: string;
  strikePrice: number; // USDC lamports
}

export function PayoffDisplay({ side, price, ticker, strikePrice }: PayoffDisplayProps) {
  const costDollars = (price / 100).toFixed(2);
  const strikeDollars = (strikePrice / 1_000_000).toFixed(2);
  const payoffDollars = ((100 - price) / 100).toFixed(2);

  const isYes = side === "yes";

  return (
    <div
      className={`rounded-lg border px-4 py-3 text-sm ${
        isYes
          ? "border-yes/20 bg-yes/5"
          : "border-no/20 bg-no/5"
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <div className={`h-2 w-2 rounded-full ${isYes ? "bg-yes" : "bg-no"}`} />
        <span className={`text-xs font-semibold uppercase tracking-wider ${isYes ? "text-yes/80" : "text-no/80"}`}>
          {isYes ? "Yes" : "No"} Payoff
        </span>
      </div>

      {isYes ? (
        <p className="text-white/80">
          You pay <span className="font-semibold text-white">${costDollars}</span>.
          You win <span className="font-semibold text-white">$1.00</span> if{" "}
          <span className="font-semibold text-white">{ticker}</span> closes at or above{" "}
          <span className="font-semibold text-white">${strikeDollars}</span>.
        </p>
      ) : (
        <p className="text-white/80">
          You pay <span className="font-semibold text-white">${costDollars}</span>.
          You win <span className="font-semibold text-white">$1.00</span> if{" "}
          <span className="font-semibold text-white">{ticker}</span> closes below{" "}
          <span className="font-semibold text-white">${strikeDollars}</span>.
        </p>
      )}

      <div className="mt-2 text-xs text-white/40">
        Max profit: ${payoffDollars} | Max loss: ${costDollars}
      </div>
    </div>
  );
}
