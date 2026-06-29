# Pydent — Phone / Calling Options (Azure vs the alternatives)

How a clinic's phone number connects to an AI voice agent in real time, what each
provider gives us, **call transfer to a human**, setup guides for each, and the
recommendation for Pydent.

---

## The architecture (always the same shape)

```
Patient dials the clinic number
   → Number provider (the phone line: Azure ACS / Ziwo / Maqsam / SIP trunk / Twilio)
      → SIP trunk
         → Voice AI engine (Vapi or Retell) — runs the agent, STT + LLM + TTS
            → Pydent backend (/api/vapi/events): booking, call logs, Open Dental
            → if the agent can't help → TRANSFER the live call to a human number
```

Two separate decisions:
1. **The phone line** (who owns/serves the number): Azure, Ziwo, Maqsam, a SIP trunk, or Twilio.
2. **The AI engine** (who runs the conversation): **Vapi** (what we use) or Retell.

Nothing is installed at the clinic for voice — the number lives in the cloud. (The only
on-prem piece is the Open Dental connector, for clinical data.)

---

## Option A — Azure (Azure Communication Services, "ACS")

What Callab appears to use. Azure is a **phone-line + telephony** provider.

- **Features:** buy phone numbers, PSTN calling, SIP Direct Routing (connect your own carrier),
  call recording, global Azure reliability/compliance, fine-grained Azure billing.
- **UAE local numbers:** **limited / often not directly available** on ACS — you usually bring a
  UAE carrier via **Direct Routing (SIP)**, which is more setup.
- **Connects to the AI:** expose ACS via SIP → point Vapi/Retell at that SIP trunk.
- **Pros:** enterprise-grade, one bill if you're already on Azure, good for scale.
- **Cons:** the most setup/complexity; UAE local-number availability is weak; overkill for a
  single clinic; you still need Vapi/Retell on top for the AI.

**Setup (Azure path):**
1. Azure portal → Communication Services → create a resource.
2. Get a number (or set up **Direct Routing** with a UAE carrier's SIP trunk).
3. Configure the SIP trunk / Direct Routing endpoint.
4. In **Vapi → Phone Numbers → BYO/SIP**, add that SIP trunk (host, credentials).
5. In **Pydent → Phone Numbers**, add the same number + assign the agent (auto-connects to Vapi).

---

## Option B — Ziwo (regional CPaaS) — recommended for UAE

- **Features:** UAE/GCC-native cloud call-center, **local UAE numbers**, SIP/WebRTC, call
  recording, IVR, agent extensions, Arabic support.
- **UAE numbers:** ✅ yes, this is their home market.
- **Connects to the AI:** Ziwo gives a SIP trunk/extension → Vapi BYO SIP.
- **Pros:** easiest UAE local number, Arabic-friendly, regional support, made for clinics/call
  centers. **Cons:** paid regional plan; another vendor.

## Option C — Maqsam (regional CPaaS)

- **Features:** MENA-focused cloud telephony, **local Arabic numbers**, call analytics,
  recording, Arabic speech. **UAE numbers:** ✅. **Connects:** SIP → Vapi BYO.
- **Pros/Cons:** same shape as Ziwo — great regional fit, paid.

## Option D — Plain SIP trunk (Etisalat / du / an aggregator)

- **Features:** a raw SIP trunk from a UAE carrier or wholesaler. **UAE numbers:** ✅ (the most
  "official" UAE line). **Connects:** SIP → Vapi BYO.
- **Pros:** real UAE telco number, can keep the clinic's existing line; **Cons:** carrier
  paperwork, more technical to provision.

## Option E — Twilio

- **Features:** the global standard, dead-simple API, great docs. **UAE local numbers:** ❌
  generally **not available** for the UAE; fine for US/UK/most countries. **Connects:** native
  Vapi integration (no SIP needed).
- **Pros:** simplest if you DON'T need a UAE number; **Cons:** no UAE local number.

---

## The AI engine: Vapi (ours) vs Retell

| | **Vapi** (what Pydent uses) | Retell |
|---|---|---|
| Runs the live call (STT+LLM+TTS) | ✅ | ✅ |
| Built-in number provisioning (Twilio/Vonage) | ✅ | ✅ |
| BYO SIP trunk (Azure/Ziwo/Maqsam/carrier) | ✅ | ✅ |
| **Call transfer to a human** | ✅ `transferCall` | ✅ |
| Tools/function calls (our booking) | ✅ (wired) | ✅ |
| Our integration | **already built** | would need re-wiring |

We already integrate Vapi end-to-end (assistant settings, booking tools, call logs, phone-number
registration). No reason to switch to Retell.

---

## Call transfer to a human (the "if it can't answer, hand off" feature)

Both engines support transferring a live call to a human number. On **Vapi** it's the
**`transferCall`** tool: you give the assistant a fallback number (e.g. the front desk mobile),
and tell it when to use it ("if the caller is upset, has a clinical emergency, or asks for a
human, transfer to +9714…"). The patient is connected to that number; warm transfer (with a
spoken intro) or cold transfer are both supported.

> **Status in Pydent:** not wired yet — it's a small add: a "Transfer to this number when the
> agent can't help" field on the voice agent, passed to Vapi as a `transferCall` tool. Say the
> word and I'll add it.

---

## Recommendation for Pydent

- **AI engine:** stay on **Vapi** (already integrated; supports BYO SIP + transfer).
- **Phone line for a UAE clinic:** use **Ziwo or Maqsam** (easiest UAE local number, Arabic,
  regional support) — **not Azure**. Azure ACS is heavier and weak on UAE local numbers.
- **If the clinic keeps its existing UAE landline:** get a **SIP trunk** from their carrier
  (Etisalat/du) and point it at Vapi.
- **Outside the UAE:** **Twilio** is the simplest (native Vapi support).

So: **Ziwo/Maqsam (line) → Vapi (AI) → Pydent (brain) → human transfer fallback.** Azure works
but is the most effort for the least UAE benefit.

### Setup in Pydent (any provider)
1. Get the number + SIP details from the provider (Ziwo/Maqsam/Azure/carrier) — or a Twilio number.
2. **Vapi → Phone Numbers**: add via SIP/BYO (or Twilio) — Vapi does the live handshake.
3. **Pydent → Voice Agents → Phone Numbers**: add the same number, assign the agent →
   it auto-registers on Vapi and routes inbound calls to that agent.
4. (Optional) add a transfer-to-human number on the agent (once we wire `transferCall`).
5. Test: call the number → agent answers → books to the calendar (+ Open Dental) → transfers to
   a human if it can't help.
