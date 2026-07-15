// Meta ads recommendation AUTOPILOT. Scans every clinic's campaigns through the
// marketing engine, surfaces Meta's recommendations + delivery errors into the
// agent Activity feed, and — for clinics that switched the toggle ON — sends
// creative-type recommendations straight to Helena, who generates a fresh image
// with the engine and prepares a PAUSED replacement ad in the same ad set.
// Deduped via hyperfx_config.autopilot_seen so each recommendation is handled once.

import { supabaseAdmin } from "@/lib/supabase-admin";
import { getHfxCreds, hfxCall, hfxConfigured } from "@/lib/hyperfx";
import { logActivity } from "@/lib/activity";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CREATIVE_RE = /creativ|fatigue|fresh|image|rotat|frequency|ad quality|new ad/i;

interface ScanItem { campaignId: string; campaignName: string; kind: "issue" | "recommendation"; text: string }

async function scanWorkspace(ws: string): Promise<ScanItem[]> {
  const creds = await getHfxCreds(ws);
  if (!hfxConfigured(creds)) return [];
  const accountsRes = await hfxCall("meta_business_list_ad_accounts", { detail: "id_only" }, creds);
  if (!accountsRes.ok) return [];
  const first = ((accountsRes.data as any)?.accounts ?? [])[0];
  if (!first?.id) return [];
  const campaignsRes = await hfxCall("meta_business_search_campaigns", { account_id: String(first.id), detail: "full", limit: 25, status_filter: ["ACTIVE"] }, creds);
  if (!campaignsRes.ok) return [];
  const items: ScanItem[] = [];
  for (const c of (campaignsRes.data as any)?.campaigns ?? []) {
    const id = String(c.id ?? "");
    const name = String(c.name ?? id);
    for (const i of Array.isArray(c.issues_info) ? c.issues_info : []) {
      items.push({ campaignId: id, campaignName: name, kind: "issue", text: String(i?.error_summary ?? i?.error_message ?? i?.message ?? "Delivery issue").slice(0, 200) });
    }
    for (const r of Array.isArray(c.recommendations) ? c.recommendations : []) {
      items.push({ campaignId: id, campaignName: name, kind: "recommendation", text: String(r?.title ?? r?.message ?? r?.code ?? "Recommendation").slice(0, 200) });
    }
  }
  return items;
}

export async function runAdsAutopilot(origin: string): Promise<{ scanned: number; alerts: number; autoRuns: number }> {
  let scanned = 0, alerts = 0, autoRuns = 0;

  // Clinics with their own engine credentials row (toggle + dedupe memory live there).
  const { data: rows } = await supabaseAdmin.from("hyperfx_config").select("workspace_id, auto_recommendations, autopilot_seen").limit(10);
  const targets: { ws: string; auto: boolean; seen: string[] }[] = (rows ?? []).map((r: any) => ({
    ws: String(r.workspace_id),
    auto: !!r.auto_recommendations,
    seen: Array.isArray(r.autopilot_seen) ? r.autopilot_seen.map(String) : [],
  }));
  // Env-credential mode (single-account testing): scan the oldest workspace too.
  if (process.env.HYPERFX_MCP_URL && targets.length === 0) {
    const { data: w } = await supabaseAdmin.from("workspaces").select("id").order("created_at").limit(1).maybeSingle();
    if (w?.id) targets.push({ ws: String(w.id), auto: false, seen: [] });
  }

  for (const t of targets.slice(0, 5)) {
    let items: ScanItem[] = [];
    try { items = await scanWorkspace(t.ws); } catch { continue; }
    scanned++;
    const fresh = items.filter((i) => !t.seen.includes(`${i.campaignId}:${i.text.slice(0, 80)}`));
    if (fresh.length === 0) continue;

    // Surface everything new in the Activity feed.
    for (const i of fresh.slice(0, 10)) {
      await logActivity(t.ws, "helena", i.kind === "issue" ? "⚠ Meta delivery issue" : "💡 Meta recommendation", `${i.campaignName}: ${i.text}`);
      alerts++;
    }

    // Auto mode: creative-type recommendations go straight to Helena.
    if (t.auto) {
      const creativeRecs = fresh.filter((i) => i.kind === "recommendation" && CREATIVE_RE.test(i.text)).slice(0, 2);
      for (const rec of creativeRecs) {
        try {
          const res = await fetch(`${origin}/api/team/helena`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workspaceId: t.ws,
              website: "",
              brand: "",
              messages: [{
                role: "user",
                content: `[ADS AUTOPILOT — pre-approved by the clinic's auto-recommendations setting] Meta issued this recommendation on campaign "${rec.campaignName}" (id ${rec.campaignId}): "${rec.text}".\nHandle it now, end to end:\n1. Find the campaign's ad sets (hyperfx tools) and pick the main one.\n2. Generate a NEW on-brand ad image (generate_featured_image).\n3. Create a new ad creative and a PAUSED replacement ad in that ad set with fresh copy (your meta tools).\n4. Reply with exactly what you created (ids + names) so it's logged. The clinic reviews and activates the new ad in the Ads tab.\nIf a step's tool fails, say precisely which one and produce the creative + copy anyway.`,
              }],
            }),
            signal: AbortSignal.timeout(120000),
          });
          const j = await res.json().catch(() => ({}));
          await logActivity(t.ws, "helena", "🤖 Autopilot creative refresh", `${rec.campaignName}: ${String(j.reply ?? j.error ?? "ran").slice(0, 300)}`);
          autoRuns++;
        } catch (e) {
          await logActivity(t.ws, "helena", "Autopilot creative refresh failed", e instanceof Error ? e.message : "error");
        }
      }
    }

    // Remember what we've handled (keep the last 200 marks).
    const newSeen = [...t.seen, ...fresh.map((i) => `${i.campaignId}:${i.text.slice(0, 80)}`)].slice(-200);
    await supabaseAdmin.from("hyperfx_config").update({ autopilot_seen: newSeen }).eq("workspace_id", t.ws);
  }

  return { scanned, alerts, autoRuns };
}
