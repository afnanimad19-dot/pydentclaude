import { NextRequest, NextResponse } from "next/server";
import { odForward } from "@/lib/opendental-gateway";

// Lists doctors/services from the clinic middleware (no clinical data).
export async function GET(req: NextRequest) {
  const ws = req.nextUrl.searchParams.get("ws");
  const { status, data } = await odForward(ws, "/doctors", { method: "GET" });
  return NextResponse.json(data, { status });
}
