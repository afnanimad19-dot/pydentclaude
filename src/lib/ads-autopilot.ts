// Meta ads recommendation AUTOPILOT. Scans every clinic's campaigns through the
// marketing engine, surfaces Meta's recommendations + delivery errors into the
// agent Activity feed, and — for clinics that switched the toggle ON — sends
// creative-type recommendations straight to Helena, who generates a fresh image
// with the engine and prepares a PAUSED replacement ad in the same ad set.
// Deduped via hyperfx_config.autopilot_seen so each recommendation is handled once.

import { supabaseAdmin } from "@/lib/supabase-admin";
import { collectAlertStrings, getHfxCreds, hfxCall, hfxConfigured, hfxFlatRow, hfxMetric, hfxRowHasMetrics, hfxRows } from "@/lib/hyperfx";
import { logActivity } from "@/lib/activity";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CREATIVE_RE = /creativ|fatigue|fresh|image|rotat|frequency|ad quality|new ad/i;

interface ScanItem { campaignId: string; campaignName: string; kind: "issue" | "recommendation"; text: string }

async function scanWorkspace(ws: string): Promise<ScanItem[]> {
  const creds = await getHfxCreds(ws);
  if (!hfxConfigured(creds)) return [];
  const accountsRes = await hfxCall("meta_business_list_ad_accounts", { detail: "id_only" }, creds);
  if (!accountsRes.ok) return [];
  const accounts: any[] = (accountsRes.data as any)?.accounts ?? [];
  const items: ScanItem[] = [];
  for (const acct of accounts.slice(0, 3)) {
    if (!acct?.id) continue;
    const accountId = String(acct.id);
    const campaignsRes = await hfxCall("meta_business_search_campaigns", { account_id: accountId, detail: "full", limit: 25, status_filter: ["ACTIVE"] }, creds);
    const camps: any[] = campaignsRes.ok ? ((campaignsRes.data as any)?.campaigns ?? []) : [];
    const itemsBefore = items.length;
    for (const c of camps) {
      const id = String(c.id ?? "");
      const name = String(c.name ?? id);
      for (const i of Array.isArray(c.issues_info) ? c.issues_info : []) {
        items.push({ campaignId: id, campaignName: name, kind: "issue", text: String(i?.error_summary ?? i?.error_message ?? i?.message ?? "Delivery issue").slice(0, 200) });
      }
      for (const r of Array.isArray(c.recommendations) ? c.recommendations : []) {
        items.push({ campaignId: id, campaignName: name, kind: "recommendation", text: String(r?.title ?? r?.message ?? r?.code ?? "Recommendation").slice(0, 200) });
      }
    }
    // This engine returns EMPTY issues/recommendations on campaign details —
    // Meta's alerts live behind its health-check tools. Read (or run) one for
    // any account whose campaigns carried nothing inline.
    if (camps.length > 0 && items.length === itemsBefore) {
      try {
        let found = collectAlertStrings((await hfxCall("meta_business_get_health_check", { account_id: accountId }, creds)).data);
        if (found.length === 0) {
          const run = await hfxCall("meta_business_run_health_check", { account_id: accountId }, creds);
          found = collectAlertStrings(run.ok ? run.data : null);
          if (found.length === 0 && run.ok) found = collectAlertStrings((await hfxCall("meta_business_get_health_check", { account_id: accountId }, creds)).data);
        }
        for (const text of found) {
          items.push({ campaignId: accountId, campaignName: String(acct.name ?? "Ad account"), kind: "recommendation", text: text.slice(0, 200) });
        }
      } catch { /* health check unavailable — skip */ }
    }

    // Performance-derived signals (Meta's API recommendations are usually
    // null): audience fatigue and dead creative on ACTIVE campaigns. Texts
    // carry no numbers so the dedupe key stays stable between runs.
    if (camps.length > 0) {
      const actId = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
      const ins = await hfxCall("meta_business_ad_insights", { object_id: actId, object_type: "account", level: "campaign", date_preset: "last_30d", include_actions: false, include_video_metrics: false }, creds);
      if (ins.ok) {
        const activeIds = new Map(camps.filter((c: any) => /ACTIVE/i.test(String(c.effective_status ?? c.status ?? ""))).map((c: any) => [String(c.id), String(c.name ?? c.id)]));
        for (const raw of hfxRows(ins.data).filter(hfxRowHasMetrics)) {
          const r = hfxFlatRow(raw);
          const cid = String(r.campaign_id ?? "");
          if (!activeIds.has(cid)) continue;
          const name = activeIds.get(cid)!;
          const impressions = hfxMetric(r, "impressions"), reach = hfxMetric(r, "reach"), clicks = hfxMetric(r, "clicks");
          if (reach > 0 && impressions / reach > 3.5) {
            items.push({ campaignId: cid, campaignName: name, kind: "recommendation", text: "Audience fatigue: this audience has seen the ads many times over the last 30 days — refresh the creative or expand the audience." });
          }
          if (impressions > 20000 && (clicks / impressions) * 100 < 0.5) {
            items.push({ campaignId: cid, campaignName: name, kind: "recommendation", text: "Low CTR on high impressions — the creative isn't stopping the scroll; generate a fresh creative and test new hooks." });
          }
        }
      }
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
