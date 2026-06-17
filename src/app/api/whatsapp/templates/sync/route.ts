import { NextResponse } from "next/server";
import { syncTemplates } from "@/lib/wa-templates-server";

export async function POST() {
  const res = await syncTemplates();
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  return NextResponse.json({ ok: true, updated: res.updated });
}
