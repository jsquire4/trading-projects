import { NextRequest, NextResponse } from "next/server";
import { getHistory } from "@/lib/market-data-proxy";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol.toUpperCase())) {
    return NextResponse.json({ error: "Valid symbol parameter required" }, { status: 400 });
  }

  const start = req.nextUrl.searchParams.get("start") ?? undefined;
  const end = req.nextUrl.searchParams.get("end") ?? undefined;

  // Validate date format if provided
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (start && !dateRegex.test(start)) {
    return NextResponse.json({ error: "Invalid start date format (YYYY-MM-DD)" }, { status: 400 });
  }
  if (end && !dateRegex.test(end)) {
    return NextResponse.json({ error: "Invalid end date format (YYYY-MM-DD)" }, { status: 400 });
  }

  try {
    const bars = await getHistory(symbol.toUpperCase(), start, end);
    return NextResponse.json(bars);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
