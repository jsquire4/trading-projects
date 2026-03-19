import { NextRequest, NextResponse } from "next/server";

const SETTLEMENT_URL =
  process.env.SETTLEMENT_URL ??
  process.env.NEXT_PUBLIC_SETTLEMENT_TRIGGER_URL?.replace("/trigger", "") ??
  "http://localhost:4002";

export async function GET() {
  try {
    const res = await fetch(`${SETTLEMENT_URL}/market-state`);
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to reach settlement service: ${msg}` },
      { status: 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const res = await fetch(`${SETTLEMENT_URL}/market-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to reach settlement service: ${msg}` },
      { status: 502 },
    );
  }
}
