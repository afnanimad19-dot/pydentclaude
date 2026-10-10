import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { a7AssertResolvedSupabaseUrl } from "@/lib/a7-guard";

// SERVER-ONLY Supabase client. Uses the service-role key, which BYPASSES RLS — so
// webhooks / cron / server-to-server code (which has no logged-in user session)
// can still read and write after workspace-scoped RLS is enabled. Every server
// module that uses this MUST filter by workspace_id itself (they already do).
//
// Never import this into a client component — the service key is server-only
// (no NEXT_PUBLIC prefix, so it's never sent to the browser). Falls back to the
// anon key if the service key isn't set, so pre-RLS deployments keep working.
// A7 guard: when A7_MODE is set, the tripwire throws unless the resolved URL
// is exactly the A7 project — this (service-role) client is the most dangerous
// write path, so it can never silently fall back to production in A7 mode.
const url = a7AssertResolvedSupabaseUrl(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co",
);
// Prefer the service-role key (bypasses RLS). Fall back to the anon/publishable
// key so the build and any pre-RLS deployment still boot — createClient throws if
// the key is ever empty, which breaks page-data collection at build time.
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "sb_publishable_I3vbDOExTRwPjaTOIxhrZw_zvI7EK_H";

/**
 * Netlify deploy-preview guard (Phase 2C). Preview and branch deploys are
 * publicly reachable builds of UNREVIEWED code, and Netlify env vars apply to
 * every context unless scoped — so without this, a PR preview would run server
 * code holding the production service-role key. When Netlify's own CONTEXT
 * says this is a preview/branch deploy, the admin client refuses at USE time
 * (builds and page loads still work; any server DB touch fails closed) unless
 * the operator consciously sets PREVIEW_ALLOW_SERVICE_ROLE=on. Production
 * (CONTEXT="production") and local dev (no CONTEXT) are untouched. This is a
 * BELT, not the fix — scope the env vars in Netlify too.
 */
export function previewServiceRoleBlocked(env: Record<string, string | undefined> = process.env): boolean {
  const ctx = env.CONTEXT; // Netlify build/runtime context name
  return (ctx === "deploy-preview" || ctx === "branch-deploy") && env.PREVIEW_ALLOW_SERVICE_ROLE !== "on";
}

const PREVIEW_BLOCK_MESSAGE =
  "Server-side database access is disabled in Netlify deploy previews and branch deploys (unreviewed code must not reach the live database). An operator can override with PREVIEW_ALLOW_SERVICE_ROLE=on after isolating the environment.";

function makeAdminClient(): SupabaseClient {
  if (previewServiceRoleBlocked()) {
    // Throw on first USE, not at import: builds only import this module, so
    // they still succeed; a request that touches the database fails closed.
    return new Proxy({} as SupabaseClient, {
      get() {
        throw new Error(PREVIEW_BLOCK_MESSAGE);
      },
    });
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export const supabaseAdmin = makeAdminClient();
