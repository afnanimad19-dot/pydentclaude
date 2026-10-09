import type { NextConfig } from "next";
import { enforceA7StartupGuard } from "./src/lib/a7-guard";

// A7 safety guard — config is loaded by `next build`, `next dev` and
// `next start`, so this aborts ALL of them (fail closed) when A7_MODE is set
// but the environment does not resolve exactly to the A7 validation project.
// Guarding the build matters because NEXT_PUBLIC_* vars are inlined into the
// client bundle at build time: without this, a build missing
// NEXT_PUBLIC_SUPABASE_URL would bake the hardcoded production fallback into
// the browser code. When A7_MODE is absent this is a no-op.
enforceA7StartupGuard(process.env);

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
