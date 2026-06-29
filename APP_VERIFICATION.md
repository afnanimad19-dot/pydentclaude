# Going live: Meta + Google verification (removing the "unverified / unsafe app" warnings)

Your integrations are **built and working**. The only thing standing between "works for me/testers" and "works for every clinic with no scary warning" is each platform's **verification**. This is account/legal paperwork on the provider side — there is no code to change. Two separate jobs:

- **Meta** (Instagram / Facebook / Messenger / Meta Ads) → Business verification + Access verification + App Review.
- **Google** (Gmail / Calendar / Analytics / Search Console) → OAuth consent screen verification.

You can keep using everything **today** via the test-user bypass in each section while the reviews are pending.

---

# PART A — META  (matches your "Publish" screenshot)

Your screenshot shows three gates: **Business verification** (Unverified), **Access verification** (locked until business verification), and **Use cases / App Review**. Do them in this order.

## A1. Business verification  ← do this first
This proves "Virgo Digital Marketing Agency" is a real business.

1. On that Publish page, click **Start verification** next to the business (or go to **business.facebook.com/settings → Security Center → Business verification**).
2. Enter the **legal business details**: legal name, address, phone number, website.
3. Upload an **official document** that shows the business name + address. For Dubai/UAE, the easiest is your **Trade Licence**. Also accepted: certificate of incorporation, a utility/bank statement, VAT/tax certificate.
4. Choose how to receive the **confirmation code** — phone, email on the business domain, or SMS — and enter it.
5. Submit. Review is usually **a few minutes to a few days**.

> Tip: the business phone/website/email you enter should match the document. Mismatches are the #1 reason it bounces.

## A2. Access verification (Tech Provider)  ← unlocks after A1
This is the "Verify that your business is a Tech Provider" box. It's required because Pydent accesses **other** businesses' assets (the clinic's Page/Instagram/ad account) on their behalf.

1. Once business verification is **approved**, the **Start verification** button under *Access verification* becomes active.
2. Submit the Tech Provider declaration. Meta says they **review and follow up within 5 days**.

## A3. App Review for the use cases  ← per use case
Your screenshot lists **Marketing API** use cases ("Create & manage ads", "Measure ad performance"). For **Instagram publishing** you'd also add the Instagram use case. For each one:

1. Open the use case → **Request Advanced Access** for the permissions it needs:
   - Instagram publishing: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`.
   - Ads: `ads_read`, `ads_management`, `business_management`.
2. Provide a short **screencast** of the flow (clinic connects → Pydent publishes a post / reads ad data) and a one-paragraph description of the use case.
3. Submit. Approval typically takes a few days.

## A4. Publish (switch to Live)
When A1–A3 are green, the **Publish** button (bottom-right of your screenshot) activates. After publishing, **any clinic** can connect with **no "unsafe app" warning**.

## Use it NOW while review is pending
- **App roles → Roles → Add people**: add the testing user (and your own clinic's Facebook account) as **Admin / Developer / Tester** → they accept the invite → they can use the unverified app fully, no warning.
- Or on the warning screen: **Advanced → Continue to <app> (unsafe)**.

---

# PART B — GOOGLE  (matches your "Google hasn't verified this app" screenshot)

That red screen appears because your OAuth app (developer **lhdmmarketing@gmail.com**) requests **sensitive/restricted scopes** (Gmail, Calendar, Analytics, Search Console) and hasn't been through Google's OAuth verification yet.

## B1. Use it RIGHT NOW (bypass — for you + test users)
1. On the warning screen, click **Advanced** (bottom-left).
2. Click **Go to <app name> (unsafe)** → **Continue** → grant access.
3. To let specific people in without the scary path: **Google Cloud Console → APIs & Services → OAuth consent screen → Test users → + Add users** → add their Gmail addresses. In **Testing** mode you can add up to **100 test users** who can connect (they still pass through the Advanced → Continue step). No verification needed for this.

This is enough to run pilots and your own clinic immediately.

## B2. Remove the warning for everyone (publish + verify)
1. **Google Cloud Console → APIs & Services → OAuth consent screen.** Fill in:
   - App name, **user support email**, app **logo**.
   - **App domain**, **Authorized domains** (your real domain), **Privacy Policy URL**, **Terms of Service URL** (these pages must be live on your domain).
   - Developer contact email.
2. Add the **scopes** the app uses (Calendar, Gmail, Analytics, Search Console).
3. Set **Publishing status → In production** (instead of Testing).
4. Click **Prepare for verification / Submit for verification.** Google then requires:
   - **Sensitive scopes** (Calendar, Analytics, Search Console, Google Business): brand/ownership verification + a **YouTube video demo** of the OAuth flow + a written justification of why you need each scope.
   - **Restricted scopes** (Gmail read/send/modify): everything above **plus** an annual **CASA security assessment** (a third-party security review — it takes time and can cost money).
5. Review can take **several weeks**, especially with Gmail.

## B3. Strong recommendation to skip the hardest part
The painful one is **Gmail** (it forces the CASA assessment). You already support **Brevo** for sending email, which needs **no Google verification at all**. So:

- For **email sending**, tell clinics to connect **Brevo** (or Gmail only for testers). Then you can **drop the Gmail scope** from the OAuth request, which removes the restricted-scope CASA requirement entirely.
- Keep **Calendar / Analytics / Search Console** (these are only "sensitive", a much lighter verification — no CASA).

That single decision turns Google verification from "weeks + security audit" into "standard sensitive-scope review."

---

# Quick checklist

**Meta:**
- [ ] A1 Business verification (Trade Licence) — *do first*
- [ ] A2 Access verification (Tech Provider) — unlocks after A1, ~5 days
- [ ] A3 App Review → Advanced Access for each use case (+ screencast)
- [ ] A4 Publish (Live)
- [ ] Meanwhile: add testers under App Roles → Roles

**Google:**
- [ ] B1 Now: Advanced → Continue (unsafe) + add Test users (up to 100)
- [ ] B2 Later: OAuth consent screen → privacy/terms URLs → In production → submit
- [ ] B3 Consider dropping the **Gmail** scope (use Brevo) to avoid the CASA security assessment
