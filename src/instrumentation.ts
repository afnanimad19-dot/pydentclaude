// Next.js server-startup hook (runs once per server instance, Node and Edge,
// and must complete before the server accepts requests).
//
// A7 safety guard: when A7_MODE is set, the server refuses to start unless the
// environment resolves EXACTLY to the A7 validation project. This is what
// keeps every legacy `?? "https://<prod>.supabase.co"` fallback unreachable in
// A7 mode — those fallbacks only engage when NEXT_PUBLIC_SUPABASE_URL is
// absent, and the guard aborts startup in that case instead. Throwing here
// fails closed: no request handler ever runs against a wrong target.
import { enforceA7StartupGuard } from "@/lib/a7-guard";

export function register() {
  const guard = enforceA7StartupGuard(process.env);
  if (guard.active) {
    // Ref only — never log env values or keys beyond this (refs are not secrets).
    console.log(`[a7-guard] A7 mode active; Supabase target verified: ${guard.ref}`);
  }
}
