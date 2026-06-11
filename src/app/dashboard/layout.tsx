import { Suspense } from "react";
import { DashboardShell } from "@/components/dashboard/shell";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <DashboardShell>{children}</DashboardShell>
    </Suspense>
  );
}
