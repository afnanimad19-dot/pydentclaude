import { NextRequest, NextResponse } from "next/server";
import { submitTemplate } from "@/lib/wa-templates-server";

export async function POST(req: NextRequest) {
  const { templateId } = (await req.json()) as { templateId?: string };
  if (!templateId) return NextResponse.json({ error: "templateId is required." }, { status: 400 });
  const res = await submitTemplate(templateId);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  return NextResponse.json({ ok: true });
}
