import type { Metadata } from "next";
import { LegalShell, Section, P, List, LEGAL_CONTACT_EMAIL, LEGAL_COMPANY } from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Terms of Service — Pydent",
  description: "The terms that govern use of the Pydent workspace.",
};

export default function TermsPage() {
  return (
    <LegalShell title="Terms of Service" subtitle={`The agreement between you and ${LEGAL_COMPANY} for using the workspace.`}>
      <Section heading="1. Acceptance">
        <P>
          By creating an account or using {LEGAL_COMPANY} (the &quot;Service&quot;), you agree to these
          Terms of Service and to our{" "}
          <a className="text-violet-300 underline hover:text-violet-200" href="/privacy">Privacy Policy</a>. If you
          use the Service on behalf of a clinic or organization, you confirm you are
          authorized to bind it to these terms.
        </P>
      </Section>

      <Section heading="2. The Service">
        <P>
          {LEGAL_COMPANY} provides a workspace for dental clinics to manage patient
          conversations, appointments, marketing and operations across voice, WhatsApp, SMS,
          email and social channels, including optional integrations with third-party
          platforms such as Meta and Google.
        </P>
      </Section>

      <Section heading="3. Accounts & responsibilities">
        <List
          items={[
            "You are responsible for the accuracy of the information you enter and for keeping your login credentials secure.",
            "You must have a lawful basis and any required patient consent to store and process the data you put into the Service.",
            "You are responsible for how you and your team use AI-generated messages and automated communications sent from your workspace.",
          ]}
        />
      </Section>

      <Section heading="4. Acceptable use">
        <P>You agree not to use the Service to:</P>
        <List
          items={[
            "Break the law, or infringe anyone's privacy, intellectual-property or other rights.",
            "Send spam or messages that violate WhatsApp, Meta, Google, Twilio or carrier rules and applicable messaging/anti-spam laws.",
            "Upload malware, attempt to breach security, or access another workspace's data.",
            "Reverse-engineer, resell or misrepresent the Service.",
          ]}
        />
      </Section>

      <Section heading="5. Third-party integrations">
        <P>
          When you connect Meta, Google, Twilio or other services, your use of those
          platforms is also governed by their terms and policies. You authorize {LEGAL_COMPANY}
          to access those accounts only for the features you enable, and you can disconnect
          at any time. We are not responsible for third-party platforms&apos; availability or
          their independent actions.
        </P>
      </Section>

      <Section heading="6. Billing & credits">
        <P>
          Paid plans and calling-minute top-ups are described in the app. Where billing is
          enabled, fees are charged in advance and consumed as you use the Service (for
          example, minutes are deducted as calls are made). Prices may change with notice.
          Except where required by law, fees are non-refundable.
        </P>
      </Section>

      <Section heading="7. Medical & professional disclaimer">
        <P>
          {LEGAL_COMPANY} is software for clinic operations and communication. It is not a
          medical device and does not provide medical advice. Clinical decisions remain the
          sole responsibility of the licensed clinic and its practitioners.
        </P>
      </Section>

      <Section heading="8. Availability & changes">
        <P>
          We work to keep the Service available but do not guarantee uninterrupted operation.
          We may modify, suspend or discontinue features, and will make reasonable efforts to
          notify you of material changes.
        </P>
      </Section>

      <Section heading="9. Warranties & liability">
        <P>
          The Service is provided &quot;as is&quot; without warranties of any kind to the fullest
          extent permitted by law. To the maximum extent permitted by law, {LEGAL_COMPANY} is
          not liable for indirect, incidental or consequential damages, and our total
          liability is limited to the amount you paid for the Service in the twelve months
          before the claim.
        </P>
      </Section>

      <Section heading="10. Termination">
        <P>
          You may stop using the Service and delete your workspace at any time (see the{" "}
          <a className="text-violet-300 underline hover:text-violet-200" href="/data-deletion">Data Deletion</a>{" "}
          page). We may suspend or terminate access for breach of these terms. On termination,
          your data is deleted or anonymized as described in the Privacy Policy.
        </P>
      </Section>

      <Section heading="11. Governing law & contact">
        <P>
          These terms are governed by the laws of the jurisdiction in which {LEGAL_COMPANY}
          operates, without regard to conflict-of-laws rules. Questions:{" "}
          <a className="text-violet-300 underline hover:text-violet-200" href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.
        </P>
      </Section>
    </LegalShell>
  );
}
