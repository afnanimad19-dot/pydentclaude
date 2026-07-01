import { createClient } from "@supabase/supabase-js";

// SERVER-ONLY Supabase client. Uses the service-role key, which BYPASSES RLS — so
// webhooks / cron / server-to-server code (which has no logged-in user session)
// can still read and write after workspace-scoped RLS is enabled. Every server
// module that uses this MUST filter by workspace_id itself (they already do).
//
// Never import this into a client component — the service key is server-only
// (no NEXT_PUBLIC prefix, so it's never sent to the browser). Falls back to the
// anon key if the service key isn't set, so pre-RLS deployments keep working.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
// Prefer the service-role key (bypasses RLS). Fall back to the anon/publishable
// key so the build and any pre-RLS deployment still boot — createClient throws if
// the key is ever empty, which breaks page-data collection at build time.
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "sb_publishable_I3vbDOExTRwPjaTOIxhrZw_zvI7EK_H";

export const supabaseAdmin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
