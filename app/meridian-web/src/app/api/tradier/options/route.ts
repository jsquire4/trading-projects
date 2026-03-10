import { NextRequest, NextResponse } from "next/server";
import { getOptionsChain, getTodayExpiration } from "@/lib/tradier-proxy";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol || !/^[A-Z]{1,10}$/.test(symbol.toUpperCase())) {
    return NextResponse.json({ error: "Valid symbol parameter required" }, { status: 400 });
  }

  const expiration = req.nextUrl.searchParams.get("expiration") ?? getTodayExpiration();

  // Validate expiration format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) {
    return NextResponse.json({ error: "Invalid expiration format (YYYY-MM-DD)" }, { status: 400 });
  }

  try {
    const chain = await getOptionsChain(symbol.toUpperCase(), expiration);
    return NextResponse.json(chain);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
