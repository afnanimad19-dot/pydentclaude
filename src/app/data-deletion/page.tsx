import type { Metadata } from "next";
import { LegalShell, Section, P, List, LEGAL_CONTACT_EMAIL, LEGAL_COMPANY } from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Data Deletion — Pydent",
  description: "How to delete your data from Pydent, including data obtained through Meta and Google.",
};

export default function DataDeletionPage() {
  return (
    <LegalShell title="Data Deletion" subtitle={`How to remove your data from ${LEGAL_COMPANY}, including anything obtained through connected Meta and Google accounts.`}>
      <Section heading="Delete specific records yourself">
        <P>
          Signed-in clinic staff can delete data directly in the app at any time — contacts,
          conversations (Inbox → ⋮ → Delete), appointments, pipeline deals, claims, ledger
          adjustments and more. Deletions take effect immediately in your workspace.
        </P>
      </Section>

      <Section heading="Disconnect a Meta or Google integration">
        <P>
          To revoke access and remove the data we hold from a connected account, disconnect it
          in <strong className="text-white">Settings → Integrations</strong>. Disconnecting
          deletes the stored access tokens and linked account identifiers for that integration
          so we can no longer access it. You can also revoke {LEGAL_COMPANY} from{" "}
          <a className="text-violet-300 underline hover:text-violet-200" href="https://www.facebook.com/settings?tab=business_tools" target="_blank" rel="noreferrer">Meta&apos;s Business Integrations</a>{" "}
          or{" "}
          <a className="text-violet-300 underline hover:text-violet-200" href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">Google&apos;s account permissions</a>.
        </P>
      </Section>

      <Section heading="Delete your entire workspace">
        <P>To erase your whole account and all associated data, send a request and we will process it:</P>
        <List
          items={[
            <>Email <a className="text-violet-300 underline hover:text-violet-200" href={`mailto:${LEGAL_CONTACT_EMAIL}?subject=Data%20deletion%20request`}>{LEGAL_CONTACT_EMAIL}</a> from the address associated with your account, with the subject &quot;Data deletion request&quot;.</>,
            "Tell us your workspace/clinic name so we can locate it.",
            "We verify the request comes from an authorized account holder, then permanently delete the workspace and its data (including any data obtained via Meta and Google).",
          ]}
        />
      </Section>

      <Section heading="What gets deleted & timing">
        <P>
          We delete your account data, clinic and patient records, conversations, and all
          tokens/identifiers obtained through connected integrations. We complete verified
          deletion requests within <strong className="text-white">30 days</strong>. Some
          information may be retained only where required by law (for example, financial
          records), and backups are purged on their normal rotation. We will confirm by email
          when deletion is complete.
        </P>
      </Section>

      <Section heading="Contact">
        <P>
          Questions about deleting your data:{" "}
          <a className="text-violet-300 underline hover:text-violet-200" href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.
        </P>
      </Section>
    </LegalShell>
  );
}
