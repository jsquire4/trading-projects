export type OddsFormat = "cents" | "percentage" | "decimal" | "fractional";

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

export function centsToPercentage(cents: number): number {
  return cents;
}

export function centsToDecimalOdds(cents: number): number {
  if (cents <= 0) return Infinity;
  return 100 / cents;
}

export function centsToFractionalOdds(cents: number): string {
  if (cents <= 0) return "N/A";
  if (cents === 100) return "0/1";

  const numerator = 100 - cents;
  const denominator = cents;
  const divisor = gcd(numerator, denominator);

  return `${numerator / divisor}/${denominator / divisor}`;
}

export function formatOdds(cents: number, format: OddsFormat): string {
  switch (format) {
    case "cents":
      return `${cents}\u00A2`;
    case "percentage":
      return `${cents}%`;
    case "decimal": {
      const d = centsToDecimalOdds(cents);
      return isFinite(d) ? d.toFixed(2) : "N/A";
    }
    case "fractional":
      return centsToFractionalOdds(cents);
  }
}
