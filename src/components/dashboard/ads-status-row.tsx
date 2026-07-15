"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui";

// A compact row showing every ad platform's connection + last-30-day spend, so
// the clinic sees all their ads at a glance. Reads /api/hyperfx/ads-status.

interface PlatformStatus { id: string; label: string; connected: boolean; account: string | null; spend: number | null; currency: string; note?: string }

const money = (n: number, cur = "USD") => `${cur === "USD" ? "$" : `${cur} `}${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export function AdsStatusRow({ ws }: { ws: string | null }) {
  const [platforms, setPlatforms] = useState<PlatformStatus[] | null>(null);

  useEffect(() => {
    fetch(`/api/hyperfx/ads-status?ws=${ws ?? ""}`)
      .then((r) => r.json())
      .then((d) => setPlatforms(d.platforms ?? []))
      .catch(() => setPlatforms([]));
  }, [ws]);

  if (!platforms) return null;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {platforms.map((p) => (
        <Card key={p.id} className="p-3.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-ink-900">{p.label}</span>
            <span className={`h-2 w-2 rounded-full ${p.connected ? "bg-emerald-500" : "bg-ink-300"}`} title={p.connected ? "Connected" : "Not connected"} />
          </div>
          {p.connected ? (
            <>
              <p className="mt-1 truncate text-[11px] text-ink-400" title={p.account ?? ""}>{p.account ?? p.note ?? "Connected"}</p>
              <p className="mt-1 text-base font-bold text-ink-900">{p.spend != null ? money(p.spend, p.currency) : "—"}</p>
              <p className="text-[10px] uppercase tracking-wide text-ink-400">spend · 30d</p>
            </>
          ) : (
            <p className="mt-1 text-[11px] text-ink-400">Not connected</p>
          )}
        </Card>
      ))}
    </div>
  );
}
