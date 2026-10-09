import { createClient } from "@supabase/supabase-js";
import { a7AssertResolvedSupabaseUrl } from "@/lib/a7-guard";

// The publishable key is designed to be public (security comes from RLS).
// Override via env vars on Netlify/Vercel if the project ever changes.
// A7 guard: when A7_MODE is set, the tripwire below throws unless the resolved
// URL is exactly the A7 project — the fallback can never engage silently.
// When A7_MODE is absent (production deploys, browser bundle) it is a no-op.
const supabaseUrl = a7AssertResolvedSupabaseUrl(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co",
);
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "sb_publishable_I3vbDOExTRwPjaTOIxhrZw_zvI7EK_H";

export const supabase = createClient(supabaseUrl, supabaseKey);
