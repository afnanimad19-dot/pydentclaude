import type { Metadata } from "next";
import { LegalShell, Section, P, List, LEGAL_CONTACT_EMAIL, LEGAL_COMPANY } from "@/components/legal-shell";

// Public Privacy Policy for the Meta app review (WhatsApp Business Platform /
// Cloud API). No auth, no robots restrictions — Meta's validators must be able
// to fetch it directly. The more scope-specific /privacy page (Google Limited
// Use, per-permission Meta scopes) remains unchanged; this page is the full,
// comprehensive policy.
export const metadata: Metadata = {
  title: "Privacy Policy | Pydent",
  description:
    "Learn how Pydent collects, uses, stores, and protects information when you use our platform and connected communication services.",
};

const LAST_UPDATED = "September 2026";

const TOC: { id: string; label: string }[] = [
  { id: "introduction", label: "1. Introduction" },
  { id: "information-we-collect", label: "2. Information We Collect" },
  { id: "whatsapp", label: "3. WhatsApp Business Platform" },
  { id: "meta-integrations", label: "4. Meta Platform Integrations" },
  { id: "how-we-use-information", label: "5. How We Use Information" },
  { id: "ai-processing", label: "6. AI Processing" },
  { id: "how-information-is-shared", label: "7. How Information Is Shared" },
  { id: "data-retention", label: "8. Data Retention" },
  { id: "data-security", label: "9. Data Security" },
  { id: "your-rights", label: "10. Data Deletion and Your Rights" },
  { id: "third-party-services", label: "11. Third-Party Services" },
  { id: "childrens-privacy", label: "12. Children's Privacy" },
  { id: "international", label: "13. International Data Processing" },
  { id: "changes", label: "14. Changes to This Privacy Policy" },
  { id: "contact", label: "15. Contact Us" },
];

export default function PrivacyPolicyPage() {
  return (
    <LegalShell
      title="Privacy Policy"
      subtitle={`How ${LEGAL_COMPANY} collects, processes, uses, stores, and protects information when you use the platform and its connected communication services.`}
      dateLine={`Last Updated: ${LAST_UPDATED}`}
    >
      <nav aria-label="Table of contents" className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <p className="mb-3 text-sm font-semibold text-white">On this page</p>
        <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
          {TOC.map((t) => (
            <li key={t.id}>
              <a href={`#${t.id}`} className="text-slate-400 transition-colors hover:text-violet-300">{t.label}</a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="introduction" heading="1. Introduction">
        <P>
          This Privacy Policy describes how {LEGAL_COMPANY}{" "}(&quot;{LEGAL_COMPANY}&quot;, &quot;we&quot;,
          &quot;us&quot;, &quot;our&quot;) collects, processes, uses, stores, and protects information when
          people use the {LEGAL_COMPANY}{" "}platform and related services. {LEGAL_COMPANY}{" "}is a
          healthcare-focused communication, CRM, automation, AI-assistant, appointment-management,
          and omnichannel platform used by clinics and their teams. It can integrate with
          communication services such as the WhatsApp Business Platform, Facebook and Messenger,
          Instagram, and other channels a clinic chooses to connect.
        </P>
        <P>
          Where a patient or customer communicates with a clinic that uses {LEGAL_COMPANY}, the
          clinic is the controller of that data and {LEGAL_COMPANY}{" "}processes it on the
          clinic&apos;s behalf to provide the services described below.
        </P>
      </Section>

      <Section id="information-we-collect" heading="2. Information We Collect">
        <P>Depending on which features a clinic uses, we may collect and process:</P>
        <List
          items={[
            <><strong className="text-white">Contact information</strong> — name, phone number, and email address of patients, leads, and contacts managed in the platform.</>,
            <><strong className="text-white">Messages and conversation content</strong> — the content of conversations handled through connected channels (for example WhatsApp, Instagram, Messenger, SMS, email) and transcripts of voice calls handled by the platform.</>,
            <><strong className="text-white">Appointment-related information</strong> — requested and booked appointment dates and times, the service or treatment requested, and related scheduling notes.</>,
            <><strong className="text-white">Information submitted through forms</strong> — details entered into booking or contact forms connected to the platform.</>,
            <><strong className="text-white">Communication metadata</strong> — timestamps, message identifiers, delivery and read status, channel, and phone-number identifiers needed to route and display conversations.</>,
            <><strong className="text-white">Account information</strong> — name, email address, and workspace details of the clinic staff who sign up for and use {LEGAL_COMPANY}.</>,
            <><strong className="text-white">Technical and device information</strong> — log data, browser and device information, and IP-derived diagnostics generated when the service is used.</>,
            <><strong className="text-white">Usage and diagnostic information</strong> — information about how the platform is used, and error and performance data needed to keep the service reliable and secure.</>,
          ]}
        />
      </Section>

      <Section id="whatsapp" heading="3. WhatsApp Business Platform">
        <P>
          {LEGAL_COMPANY}{" "}can integrate with the <strong className="text-white">WhatsApp Business
          Platform</strong> provided by Meta. When a person communicates with a business through
          WhatsApp, relevant information may be processed by {LEGAL_COMPANY}{" "}to provide messaging,
          customer service, appointment, automation, and communication functionality on the
          business&apos;s behalf. This may include:
        </P>
        <List
          items={[
            "The WhatsApp phone number used to message the business.",
            "WhatsApp profile or display information made available through the API (such as the profile name).",
            "Message content sent to and from the business.",
            "Message timestamps and message IDs.",
            "Delivery, read, and other status information.",
            "Media or attachments, when applicable.",
          ]}
        />
        <P>
          This information is used to deliver the conversation to the business&apos;s inbox,
          generate and send replies (including AI-assisted replies where the business has enabled
          them), manage appointments, and provide the related features the business has turned on.
          Use of WhatsApp is also subject to the applicable{" "}
          <a className="text-violet-300 underline hover:text-violet-200" href="https://www.whatsapp.com/legal/" target="_blank" rel="noreferrer">WhatsApp terms and privacy policies</a>{" "}
          and{" "}
          <a className="text-violet-300 underline hover:text-violet-200" href="https://www.facebook.com/privacy/policy/" target="_blank" rel="noreferrer">Meta&apos;s privacy policy</a>.
        </P>
      </Section>

      <Section id="meta-integrations" heading="4. Meta Platform Integrations">
        <P>
          {LEGAL_COMPANY}{" "}may integrate with Meta products and services, including{" "}
          <strong className="text-white">WhatsApp</strong>, <strong className="text-white">Facebook</strong>,{" "}
          <strong className="text-white">Messenger</strong>, and <strong className="text-white">Instagram</strong>.
          Data received through Meta APIs is used only to provide the relevant {LEGAL_COMPANY}{" "}
          functionality and integrations that the connecting business has enabled — for example,
          receiving and answering messages in the omnichannel inbox, or publishing the
          business&apos;s own content where that feature is used. We do not use data received
          through Meta APIs for any other purpose, and a business can disconnect an integration at
          any time (see Section 10).
        </P>
        <P>
          A detailed description of the specific Meta and Google permissions the platform can
          request, and how each is used, is available on our{" "}
          <a className="text-violet-300 underline hover:text-violet-200" href="/privacy">integration privacy page</a>.
        </P>
      </Section>

      <Section id="how-we-use-information" heading="5. How We Use Information">
        <P>We use the information described above for purposes including:</P>
        <List
          items={[
            "Providing, operating, and maintaining the Pydent services.",
            "Delivering and receiving communications across connected channels.",
            "Managing conversations, contacts, and the clinic's pipeline.",
            "Providing customer support.",
            "Appointment scheduling, reminders, and management.",
            "Automation and workflows the business has configured.",
            "AI-assisted functionality, where the business has enabled it (see Section 6).",
            "Improving service reliability and performance.",
            "Security, abuse prevention, and fraud prevention.",
            "Troubleshooting and diagnostics.",
            "Complying with applicable legal obligations.",
          ]}
        />
      </Section>

      <Section id="ai-processing" heading="6. AI Processing">
        <P>
          Certain {LEGAL_COMPANY}{" "}functionality uses artificial intelligence to assist businesses
          with tasks such as:
        </P>
        <List
          items={[
            "Drafting and sending responses to customer messages.",
            "Handling customer communication across chat and voice channels.",
            "Processing conversations — for example transcription, summaries, and extracting appointment details.",
            "Lead qualification.",
            "Workflow automation.",
          ]}
        />
        <P>
          Where AI functionality is enabled, relevant information (such as message content or call
          transcripts) may be processed by configured AI and service providers to the extent
          necessary to deliver that functionality. AI processing operates under the instructions
          and configuration of the business using the platform.
        </P>
      </Section>

      <Section id="how-information-is-shared" heading="7. How Information Is Shared">
        <P>
          We share information with service providers only as reasonably necessary to operate the
          platform. These include categories such as:
        </P>
        <List
          items={[
            "Hosting and infrastructure providers that run the application.",
            "Messaging and platform providers used to deliver communications (including Meta, for WhatsApp, Messenger, and Instagram messaging).",
            "Database and storage providers.",
            "AI service providers, when AI functionality is enabled.",
            "Analytics and security providers, where applicable.",
          ]}
        />
        <P>
          <strong className="text-white">{LEGAL_COMPANY}{" "}does not sell personal information for
          monetary consideration.</strong> We may also disclose information where required by law
          or to protect the rights, safety, and security of our users and services.
        </P>
      </Section>

      <Section id="data-retention" heading="8. Data Retention">
        <P>
          We retain information only for as long as reasonably necessary to provide the services,
          for legitimate business purposes, to meet contractual requirements, for security and
          dispute resolution, and to comply with applicable legal obligations. When information is
          no longer needed for these purposes, we delete or anonymize it within a reasonable
          period.
        </P>
      </Section>

      <Section id="data-security" heading="9. Data Security">
        <P>
          We use reasonable technical and organizational safeguards to protect information —
          including access controls, encryption of data in transit, and per-workspace isolation of
          each business&apos;s data. No method of transmission or storage is completely secure, and
          we cannot guarantee absolute security; we work to protect information appropriately and
          to address issues promptly if they arise.
        </P>
      </Section>

      <Section id="your-rights" heading="10. Data Deletion and Your Rights">
        <P>Depending on your location and relationship with the business using {LEGAL_COMPANY}, you may request:</P>
        <List
          items={[
            "Access to the personal information held about you.",
            "Correction of inaccurate information.",
            "Deletion of your information.",
            "Other privacy rights available under applicable law.",
          ]}
        />
        <P>
          To make a request, email{" "}
          <a className="text-violet-300 underline hover:text-violet-200" href={`mailto:${LEGAL_CONTACT_EMAIL}?subject=Privacy%20request`}>{LEGAL_CONTACT_EMAIL}</a>.
          If you are a patient or customer of a business that uses {LEGAL_COMPANY}, you can also
          contact that business directly, and we will support it in fulfilling your request.
          Step-by-step deletion instructions — including how to delete data obtained through
          connected Meta accounts — are published on our{" "}
          <a className="text-violet-300 underline hover:text-violet-200" href="/data-deletion">Data Deletion Instructions</a>{" "}
          page.
        </P>
      </Section>

      <Section id="third-party-services" heading="11. Third-Party Services">
        <P>
          {LEGAL_COMPANY}{" "}integrates with third-party services (for example Meta platforms,
          calendar providers, and telephony providers). Those services are operated by third
          parties and have their own privacy policies and terms, which apply to your use of them.
          We encourage you to review the policies of any third-party service you use.
        </P>
      </Section>

      <Section id="childrens-privacy" heading="12. Children's Privacy">
        <P>
          {LEGAL_COMPANY}{" "}services are directed to businesses and their staff and are not
          intentionally directed to children. Where an authorized healthcare or business
          organization uses the platform in an appropriate context that involves records relating
          to minors (for example a pediatric patient&apos;s appointment made by a parent or
          guardian), that data is handled on the organization&apos;s behalf and governed by the
          organization&apos;s own consent processes and applicable regulations.
        </P>
      </Section>

      <Section id="international" heading="13. International Data Processing">
        <P>
          Our service providers and infrastructure may process information in jurisdictions
          different from your own. Where such transfers occur, they are subject to applicable
          safeguards and contractual arrangements where required by law.
        </P>
      </Section>

      <Section id="changes" heading="14. Changes to This Privacy Policy">
        <P>
          We may update this Privacy Policy periodically. When we make material revisions, we will
          update the &quot;Last Updated&quot; date at the top of this page. Continued use of the
          services after an update constitutes acceptance of the revised policy.
        </P>
      </Section>

      <Section id="contact" heading="15. Contact Us">
        <P>
          For questions about this Privacy Policy, or to exercise your privacy rights, contact:
        </P>
        <List
          items={[
            <><strong className="text-white">{LEGAL_COMPANY}</strong></>,
            <>Email: <a className="text-violet-300 underline hover:text-violet-200" href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a></>,
          ]}
        />
      </Section>
    </LegalShell>
  );
}
