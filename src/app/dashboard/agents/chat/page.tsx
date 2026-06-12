import { AgentsView } from "@/components/dashboard/agents-shared";

export default function ChatAgentsPage() {
  return (
    <AgentsView
      filter="chat"
      defaultKind="chat"
      title="Chat Agents"
      subtitle="Agents that answer WhatsApp, Instagram, SMS and email — grounded in their knowledge base."
    />
  );
}
