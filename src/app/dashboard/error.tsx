"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw, LayoutDashboard } from "lucide-react";

// Dashboard-wide error boundary: an unexpected crash on any dashboard page used
// to show the framework's dead "application error" screen with no way forward.
// This replaces it with a recoverable card that shows the REAL error message
// (so it can be reported and fixed) plus working "Try again" / "Overview" exits.
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Dashboard page crashed:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl border border-ink-200 bg-surface p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10">
          <AlertTriangle className="h-6 w-6 text-amber-500" />
        </div>
        <h2 className="text-lg font-semibold text-ink-900">This page hit an error</h2>
        <p className="mt-1 text-sm text-ink-500">
          The rest of the dashboard is fine — try again, or head back to the overview.
        </p>
        {error?.message && (
          <p className="mx-auto mt-3 max-w-md overflow-x-auto rounded-lg bg-ink-50 px-3 py-2 text-left font-mono text-[11px] text-ink-600">
            {String(error.message).slice(0, 400)}
          </p>
        )}
        <div className="mt-5 flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <RefreshCw className="h-4 w-4" /> Try again
          </button>
          <Link
            href="/dashboard"
            className="flex items-center gap-2 rounded-xl border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            <LayoutDashboard className="h-4 w-4" /> Overview
          </Link>
        </div>
      </div>
    </div>
  );
}
