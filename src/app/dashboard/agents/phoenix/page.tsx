import { redirect } from "next/navigation";

// Phoenix's outbound launcher now lives inside Outbound Campaigns (agent-agnostic
// — pick any agent, paste any list). This route just forwards there.
export default function PhoenixRedirect() {
  redirect("/dashboard/agents/campaigns");
}
