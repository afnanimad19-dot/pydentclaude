import { NextRequest, NextResponse } from "next/server";
import { getHfxCreds, hfxCall, hfxConfigured } from "@/lib/hyperfx";

// Location search for the campaign wizard's area picker — type "Dubai" and get
// back the matching countries, regions (emirates), cities and neighbourhoods so
// the clinic can include/exclude exactly the areas they want (Meta-style).
export const runtime = "nodejs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ results: [] });
  const creds = await getHfxCreds(req.nextUrl.searchParams.get("ws"));
  if (!hfxConfigured(creds)) return NextResponse.json({ results: [], error: "Marketing engine not configured." }, { status: 400 });

  const r = await hfxCall("meta_business_targeting_search", { search_type: "adgeolocation", q, limit: 20, detail: "core" }, creds);
  if (!r.ok) return NextResponse.json({ results: [], error: r.error }, { status: 502 });

  const rows: any[] = Array.isArray(r.data) ? r.data : ((r.data as any)?.data ?? (r.data as any)?.results ?? []);
  const results = rows
    .map((g: any) => ({
      key: String(g.key ?? g.id ?? ""),
      name: String(g.name ?? ""),
      type: String(g.type ?? "").toLowerCase(), // country | region | city | neighborhood | subcity | zip
      region: g.region ?? g.region_name ?? null,
      country: g.country_name ?? g.country_code ?? null,
      supportsRadius: /city|neighborhood|subcity|zip|place/.test(String(g.type ?? "").toLowerCase()),
    }))
    .filter((g: any) => g.key && g.name);

  return NextResponse.json({ results });
}
