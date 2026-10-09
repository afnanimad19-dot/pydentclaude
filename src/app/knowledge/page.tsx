import { redirect } from "next/navigation";

// /knowledge → the Knowledge Base page inside the dashboard shell (which
// provides the sign-in guard, navigation and workspace context).
export default function KnowledgeRedirect() {
  redirect("/dashboard/knowledge");
}
