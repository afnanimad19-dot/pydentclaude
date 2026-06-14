import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { WhatsAppConfigForm } from "@/components/dashboard/whatsapp-config";

export default function WhatsAppConnectionPage() {
  return (
    <>
      <Link href="/dashboard/settings" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-900">
        <ArrowLeft className="h-4 w-4" /> Settings
      </Link>
      <PageHeader title="WhatsApp connection" subtitle="Connect the Meta WhatsApp Business API for this clinic." />
      <WhatsAppConfigForm />
    </>
  );
}
