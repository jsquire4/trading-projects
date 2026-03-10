import { NextRequest, NextResponse } from "next/server";
import { getExpirations } from "@/lib/tradier-proxy";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol || !/^[A-Z]{1,10}$/.test(symbol.toUpperCase())) {
    return NextResponse.json({ error: "Valid symbol parameter required" }, { status: 400 });
  }

  try {
    const expirations = await getExpirations(symbol.toUpperCase());
    return NextResponse.json(expirations);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
