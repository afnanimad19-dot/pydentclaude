import { AgentsView } from "@/components/dashboard/agents-shared";

export default function VoiceAgentsPage() {
  return (
    <AgentsView
      filter="voice"
      defaultKind="voice"
      title="Voice Agents"
      subtitle="Phone agents powered by Vapi — configure here, test them live in your browser, route them in the Agent Hub."
    />
  );
}
