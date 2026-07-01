import type { Metadata } from "next";
import { LegalShell, Section, P, List, LEGAL_CONTACT_EMAIL, LEGAL_COMPANY } from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Privacy Policy — Pydent",
  description: "How Pydent collects, uses, shares and protects data, including data obtained through Meta and Google integrations.",
};

export default function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" subtitle={`How ${LEGAL_COMPANY} collects, uses, protects and deletes data — including data accessed through Meta and Google.`}>
      <Section heading="1. Who we are">
        <P>
          {LEGAL_COMPANY} (&quot;{LEGAL_COMPANY}&quot;, &quot;we&quot;, &quot;us&quot;) provides a workspace for dental
          clinics to manage patient conversations, appointments, marketing and clinic
          operations across voice, WhatsApp, SMS, email and social channels. This policy
          explains what data we handle and why. If you are a patient of a clinic that uses
          {" "}{LEGAL_COMPANY}, the clinic is the controller of your data and {LEGAL_COMPANY} processes
          it on the clinic&apos;s behalf.
        </P>
      </Section>

      <Section heading="2. Data we collect">
        <List
          items={[
            <><strong className="text-white">Account data</strong> — name, email and workspace details of the clinic staff who sign up.</>,
            <><strong className="text-white">Clinic &amp; patient records</strong> — contacts, appointments, treatment/pipeline notes, messages and files that the clinic enters or that flow in from connected channels.</>,
            <><strong className="text-white">Conversation content</strong> — WhatsApp, SMS, email, Instagram/Messenger and voice-call messages and transcripts handled inside the workspace.</>,
            <><strong className="text-white">Integration data</strong> — information we access, with your explicit consent, from connected Meta and Google accounts (see sections 4 and 5).</>,
            <><strong className="text-white">Usage &amp; technical data</strong> — log data, device/browser information and diagnostics needed to run and secure the service.</>,
          ]}
        />
      </Section>

      <Section heading="3. How we use data">
        <List
          items={[
            "To provide the workspace: routing messages, booking appointments, running the pipeline, and sending communications the clinic initiates.",
            "To operate AI agents that answer patient messages and calls on the clinic's behalf.",
            "To publish or schedule the clinic's own content to its connected Meta accounts, when the clinic asks us to.",
            "To secure the service, prevent abuse, provide support, and meet legal obligations.",
          ]}
        />
        <P>We do <strong className="text-white">not</strong> sell personal data, and we do not use patient health information for advertising.</P>
      </Section>

      <Section heading="4. Meta (Facebook, Instagram, WhatsApp) data">
        <P>
          When a clinic connects a Meta account, we request only the permissions needed for
          the features it turns on, and we use the data <em>only</em> for those features:
        </P>
        <List
          items={[
            <><code className="text-violet-300">pages_show_list</code>, <code className="text-violet-300">pages_read_engagement</code>, <code className="text-violet-300">pages_manage_posts</code> — to list the clinic&apos;s Facebook Pages and publish the clinic&apos;s own posts.</>,
            <><code className="text-violet-300">instagram_basic</code>, <code className="text-violet-300">instagram_content_publish</code> — to publish the clinic&apos;s own scheduled Instagram posts.</>,
            <><code className="text-violet-300">ads_read</code>, <code className="text-violet-300">ads_management</code>, <code className="text-violet-300">business_management</code> — to read and manage the clinic&apos;s own ad campaigns when the clinic uses that feature.</>,
            <>WhatsApp Business messaging — to send and receive the clinic&apos;s patient conversations in the inbox.</>,
          ]}
        />
        <P>
          Data obtained through Meta is used solely to deliver these features to the clinic
          that authorized it. We store only what is required (for example, a Page token and
          the linked account IDs), we never share it with third parties for their own use,
          and it is deleted when the clinic disconnects the integration or requests deletion
          (see section 8). Our use complies with the Meta Platform Terms and Developer
          Policies.
        </P>
      </Section>

      <Section heading="5. Google data">
        <P>
          When a clinic connects a Google account, we request only the scopes for the
          products it enables, and use them only to provide that feature to the clinic:
        </P>
        <List
          items={[
            <><code className="text-violet-300">calendar.events</code> — to write and update the clinic&apos;s appointments on its Google Calendar.</>,
            <><code className="text-violet-300">analytics.readonly</code>, <code className="text-violet-300">webmasters.readonly</code> — to show the clinic its own Analytics and Search Console metrics.</>,
            <><code className="text-violet-300">business.manage</code>, <code className="text-violet-300">adwords</code> — to manage the clinic&apos;s own Business Profile and Google Ads when it uses those features.</>,
            <><code className="text-violet-300">youtube.readonly</code> — to read the clinic&apos;s own YouTube data where enabled.</>,
          ]}
        />
        <P>
          {LEGAL_COMPANY}&apos;s use of information received from Google APIs adheres to the{" "}
          <a className="text-violet-300 underline hover:text-violet-200" href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">
            Google API Services User Data Policy
          </a>, including the Limited Use requirements. We do not use Google user data for
          advertising, we do not sell it, and we do not transfer it except to provide the
          feature, comply with law, or with your explicit consent.
        </P>
      </Section>

      <Section heading="6. How we share data">
        <P>We share data only with:</P>
        <List
          items={[
            "Sub-processors that run the service (e.g. cloud hosting/database, messaging and AI providers) under contracts that limit them to processing on our instructions.",
            "The connected platforms themselves (Meta, Google, Twilio, etc.) as needed to deliver the feature you enabled.",
            "Authorities when required by law.",
          ]}
        />
      </Section>

      <Section heading="7. Data retention & security">
        <P>
          We keep data for as long as the clinic&apos;s workspace is active, then delete or
          anonymize it within a reasonable period unless retention is legally required. Data
          is isolated per clinic workspace and protected with access controls, encryption in
          transit, and row-level security in the database.
        </P>
      </Section>

      <Section heading="8. Your rights & deleting your data">
        <P>
          You can access, correct, export or delete data. Clinic staff can delete records in
          the app; to remove an entire workspace, or to have data obtained via Meta/Google
          erased, follow our{" "}
          <a className="text-violet-300 underline hover:text-violet-200" href="/data-deletion">Data Deletion instructions</a>{" "}
          or email us. Disconnecting a Meta or Google integration removes the stored tokens
          and access for that integration.
        </P>
      </Section>

      <Section heading="9. Children">
        <P>
          The {LEGAL_COMPANY} workspace is for clinic staff, not for use by children. Patient
          records a clinic stores are governed by the clinic&apos;s own consent and local
          healthcare regulations.
        </P>
      </Section>

      <Section heading="10. Changes & contact">
        <P>
          We may update this policy and will change the effective date above. Questions or
          requests: <a className="text-violet-300 underline hover:text-violet-200" href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.
        </P>
      </Section>
    </LegalShell>
  );
}
