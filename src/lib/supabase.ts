import { createClient } from "@supabase/supabase-js";

// The publishable key is designed to be public (security comes from RLS).
// Override via env vars on Netlify/Vercel if the project ever changes.
const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://mzqynjywncbvqfikbzgm.supabase.co";
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "sb_publishable_I3vbDOExTRwPjaTOIxhrZw_zvI7EK_H";

export const supabase = createClient(supabaseUrl, supabaseKey);
