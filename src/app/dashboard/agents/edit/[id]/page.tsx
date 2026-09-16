"use client";

// Edit-agent page (was a popup): /dashboard/agents/edit/<agent id>
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AgentModal } from "@/components/dashboard/agents-shared";
import { fetchAgent, type AiAgent } from "@/lib/db";

export default function EditAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [agent, setAgent] = useState<AiAgent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAgent(id).then((a) => {
      setAgent(a);
      setLoading(false);
    });
  }, [id]);

  if (loading) return <p className="py-20 text-center text-sm text-ink-400">Loading agent…</p>;
  if (!agent)
    return (
      <div className="py-20 text-center">
        <p className="text-sm text-ink-500">Agent not found.</p>
        <Link href="/dashboard/agents" className="mt-3 inline-block text-sm font-semibold text-brand-600">
          ← Back to agents
        </Link>
      </div>
    );

  const back = () =>
    router.push(agent.kind === "voice" ? "/dashboard/agents/voice" : "/dashboard/agents/chat");
  return <AgentModal asPage initial={agent} onClose={back} onSaved={() => {}} />;
}
