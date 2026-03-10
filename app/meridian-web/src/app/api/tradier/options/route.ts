import { NextRequest, NextResponse } from "next/server";
import { getOptionsChain, getExpirations, getTodayExpiration } from "@/lib/tradier-proxy";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol || !/^[A-Z]{1,10}$/.test(symbol.toUpperCase())) {
    return NextResponse.json({ error: "Valid symbol parameter required" }, { status: 400 });
  }

  let expiration = req.nextUrl.searchParams.get("expiration");

  // Validate expiration format if provided
  if (expiration && !/^\d{4}-\d{2}-\d{2}$/.test(expiration)) {
    return NextResponse.json({ error: "Invalid expiration format (YYYY-MM-DD)" }, { status: 400 });
  }

  try {
    const sym = symbol.toUpperCase();

    if (!expiration) {
      // Try today first (0DTE), then fall back to nearest expiration
      const today = getTodayExpiration();
      const chain = await getOptionsChain(sym, today);
      if (chain.length > 0) {
        return NextResponse.json(chain, {
          headers: { "X-Expiration": today },
        });
      }

      // No 0DTE — find nearest expiration
      const expirations = await getExpirations(sym);
      const nearest = expirations.find((d) => d >= today);
      if (!nearest) {
        return NextResponse.json([], {
          headers: { "X-Expiration": "none" },
        });
      }
      expiration = nearest;
    }

    const chain = await getOptionsChain(sym, expiration);
    return NextResponse.json(chain, {
      headers: { "X-Expiration": expiration },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
