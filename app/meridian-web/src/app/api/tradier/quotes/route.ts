import { NextRequest, NextResponse } from "next/server";
import { getQuotes } from "@/lib/tradier-proxy";

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

  // Validate symbols are alphanumeric
  if (symbols.some((s) => !/^[A-Z]{1,10}$/.test(s))) {
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
