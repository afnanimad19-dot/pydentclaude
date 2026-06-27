import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { startRun } from "@/lib/workflow-runner";

// Manually start a workflow run (a "test run" from the builder/list). Body:
// { workspaceId, workflowId, phone?, name?, patientId? }. Loads the saved
// workflow and runs it against the given contact.
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { workspaceId?: string; workflowId?: string; phone?: string; name?: string; patientId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }
  const { workspaceId, workflowId } = body;
  if (!workflowId) return NextResponse.json({ ok: false, error: "workflowId is required." }, { status: 400 });

  const { data: wf, error } = await supabase.from("workflows").select("*").eq("id", workflowId).maybeSingle();
  if (error || !wf) return NextResponse.json({ ok: false, error: "Workflow not found." }, { status: 404 });

  try {
    await startRun(supabase, workspaceId ?? wf.workspace_id ?? null, wf, {
      patientId: body.patientId ?? null,
      conversationId: null,
      channel: wf.channel ?? "whatsapp",
      contactPhone: body.phone ?? "",
      name: body.name ?? "Test contact",
      lastMessage: "",
    });
    return NextResponse.json({ ok: true, message: "Workflow run started." });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Run failed." }, { status: 500 });
  }
}
