import { AgentsView } from "@/components/dashboard/agents-shared";

export default function AllAgentsPage() {
  return (
    <AgentsView
      filter="all"
      title="AI Agents"
      subtitle="All your voice and chat agents — each with its own knowledge base, abilities and channels."
    />
  );
}
