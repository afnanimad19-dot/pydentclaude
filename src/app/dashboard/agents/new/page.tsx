"use client";

// Create-agent page (was a popup): /dashboard/agents/new?kind=voice|chat
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AgentModal } from "@/components/dashboard/agents-shared";

function NewAgentInner() {
  const router = useRouter();
  const kind = useSearchParams().get("kind") === "voice" ? "voice" : "chat";
  const back = () => router.push(kind === "voice" ? "/dashboard/agents/voice" : "/dashboard/agents/chat");
  return <AgentModal asPage initial={null} defaultKind={kind} onClose={back} onSaved={() => {}} />;
}

export default function NewAgentPage() {
  // useSearchParams needs a Suspense boundary for prerendering.
  return (
    <Suspense fallback={<p className="py-20 text-center text-sm text-ink-400">Loading…</p>}>
      <NewAgentInner />
    </Suspense>
  );
}
