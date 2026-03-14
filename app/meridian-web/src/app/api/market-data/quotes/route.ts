import { NextRequest, NextResponse } from "next/server";
import { getQuotes } from "@/lib/market-data-proxy";

export async function GET(req: NextRequest) {
  const symbolsParam = req.nextUrl.searchParams.get("symbols");
  if (!symbolsParam) {
    return NextResponse.json({ error: "symbols parameter required" }, { status: 400 });
  }

  const symbols = symbolsParam
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (symbols.length === 0 || symbols.length > 20) {
    return NextResponse.json({ error: "1-20 symbols required" }, { status: 400 });
  }

  // Validate symbols: alphanumeric with dots and hyphens (e.g. BRK.B, BF-B)
  if (symbols.some((s) => !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s))) {
    return NextResponse.json({ error: "Invalid symbol format" }, { status: 400 });
  }

  try {
    const quotes = await getQuotes(symbols);
    return NextResponse.json(quotes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
