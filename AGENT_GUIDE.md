# How to create a Chat Agent that auto-books (step by step)

Goal: a WhatsApp/Instagram/Messenger agent that answers patients, qualifies them,
and **books appointments automatically** — without asking the same question twice.

## 1. Create the agent
**AI Agents → New agent → Chat.** Fill in:
- **Name:** e.g. `Sarah`.
- **Agent type:** `Receptionist` (or Sales / Appointment setter / Follow-up).
- **Language:** the clinic's main language (e.g. English, Arabic).
- **Model:** start with `openai/gpt-4o-mini` (fast + cheap); upgrade later if needed.
- **Instructions:** *what* the agent does (role + goal). Example to paste:
  > You are Sarah, the friendly receptionist for Bright Smile Dental in Dubai.
  > Your job is to answer patient questions and BOOK appointments. Identify the
  > service they want (cleaning, check-up, whitening, Invisalign, emergency),
  > check real available times, offer 2–3 options, confirm, and book. If they ask
  > about hours, pricing or insurance, answer from the knowledge base.
- **Behavior:** *how* it acts (the rules that fix repeated questions). Example to paste:
  > • Remember what the patient already told you — never re-ask their name, service
  >   or preferred time.
  > • Ask ONE question at a time. Keep replies to 1–2 short sentences.
  > • Don't repeat the greeting on every message; greet once.
  > • Before offering times, check availability and only offer open slots.
  > • Never invent prices or clinical advice — if unsure, say you'll check with the team.
  > • Once a time is agreed, book it and confirm in one short sentence.
- **Knowledge base:** upload the clinic's info (hours, address, services, prices,
  insurance, FAQs). The agent answers **only** from these. (Today `.txt/.md/.csv/.json`
  are read fully; PDF/Word support is on the roadmap — paste their text as `.txt` for now.)
- **Abilities:** turn ON **Book appointments**, **Reschedule**, **Cancel**.
- **Channels:** tick WhatsApp (and Instagram/Messenger if used).
- **Status:** `Live`.
- **Save.**

## 2. Test it
On the agent card → **Test chat**. Try: "Hi", "Do you do whitening?", "Can I come
tomorrow at 2pm for a cleaning?" — confirm it offers times and books cleanly and
doesn't repeat questions. Tweak the Behavior box until it feels right.

## 3. Make it answer real patients automatically
**AI Agents → Agent Hub** → on the **WhatsApp** row, pick this agent and toggle it
**On** (do the same for Instagram/Messenger). Now every inbound message on that
channel is answered by this agent automatically — unless you click **Assign to me**
in the inbox to take over (and **Hand back to AI** to resume).

## 4. What happens on a booking
When the patient agrees on a time, the agent:
1. Checks open slots (Open Dental if connected, else your Calendar's free hours).
2. Creates the appointment → shows on **Calendar**, linked to the patient
   (auto-captured as a contact with source = WhatsApp).
3. Confirms to the patient. Reschedule/cancel work the same way.

## Tips to train it well
- Put **facts** (hours, prices, services, doctors) in the **Knowledge base**, not Instructions.
- Put **rules** (tone, one-question-at-a-time, no repeats) in **Behavior**.
- Keep **Instructions** about the goal and the steps.
- If it makes a mistake, add a one-line rule to **Behavior** and re-test — that's the fix loop.
