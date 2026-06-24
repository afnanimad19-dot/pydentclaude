"use client";

import { useEffect, useState } from "react";
import { GraduationCap, Sparkles, Copy, Trash2, Check } from "lucide-react";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import {
  fetchLearningQuestions,
  fetchAgents,
  teachAgent,
  deleteLearningQuestion,
  type LearningQuestion,
  type AiAgent,
} from "@/lib/db";

type Field = "knowledgeBase" | "instructions" | "behavior";

export default function LearningAgentPage() {
  const [questions, setQuestions] = useState<LearningQuestion[]>([]);
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [teaching, setTeaching] = useState<LearningQuestion | null>(null);

  function refresh() {
    fetchLearningQuestions().then((q) => { setQuestions(q); setLoading(false); });
  }
  useEffect(() => {
    refresh();
    fetchAgents().then((r) => setAgents(r.agents));
  }, []);

  const open = questions.filter((q) => q.status === "open");
  const taught = questions.filter((q) => q.status === "taught");

  return (
    <>
      {teaching && (
        <TeachModal
          q={teaching}
          agents={agents}
          onClose={() => setTeaching(null)}
          onTaught={() => { setTeaching(null); refresh(); }}
        />
      )}

      <PageHeader
        title="Learning Agent"
        subtitle="Questions your agents couldn't answer. Teach the answer once and the agent remembers it next time."
      />

      <div className="mb-6 flex items-start gap-2 rounded-xl border border-brand-500/20 bg-brand-500/5 px-4 py-3 text-sm text-ink-600">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
        <span>
          When an agent says it&apos;ll &ldquo;check with the team,&rdquo; the patient&apos;s question lands here — summarized, so the same
          question counts up instead of repeating. Click <strong>Teach</strong>, write the answer, pick where it goes
          (knowledge base, instructions or behavior), and it&apos;s added to that agent.
        </span>
      </div>

      {loading ? (
        <Card className="p-10 text-center text-sm text-ink-400">Loading…</Card>
      ) : open.length === 0 && taught.length === 0 ? (
        <Card className="p-10 text-center text-sm text-ink-500">
          Nothing yet — once your agents hit a question they can&apos;t answer, it shows up here to teach.
        </Card>
      ) : (
        <div className="space-y-6">
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-900">
              <GraduationCap className="h-4 w-4 text-brand-500" /> Needs an answer ({open.length})
            </h2>
            {open.length === 0 ? (
              <Card className="p-6 text-center text-sm text-ink-400">All caught up — nothing waiting to be taught.</Card>
            ) : (
              <div className="space-y-2.5">
                {open.map((q) => (
                  <Card key={q.id} className="flex flex-wrap items-center gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink-900">{q.question}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-400">
                        <span className="rounded-full bg-ink-100 px-2 py-0.5 font-medium text-ink-600">{q.agentName || "Agent"}</span>
                        <span>asked {q.timesAsked}×</span>
                      </p>
                    </div>
                    <button
                      onClick={() => { navigator.clipboard?.writeText(q.question); toast("Question copied.", "success"); }}
                      title="Copy question"
                      className="rounded-lg border border-ink-200 p-2 text-ink-500 hover:bg-ink-50"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => deleteLearningQuestion(q.id).then(refresh)}
                      title="Dismiss"
                      className="rounded-lg border border-ink-200 p-2 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setTeaching(q)}
                      className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
                    >
                      <GraduationCap className="h-4 w-4" /> Teach
                    </button>
                  </Card>
                ))}
              </div>
            )}
          </section>

          {taught.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-ink-900">Already taught ({taught.length})</h2>
              <div className="space-y-2">
                {taught.map((q) => (
                  <div key={q.id} className="flex items-center gap-3 rounded-xl border border-ink-100 bg-ink-50/60 px-4 py-2.5 text-sm">
                    <Check className="h-4 w-4 shrink-0 text-emerald-500" />
                    <span className="min-w-0 flex-1 truncate text-ink-600">{q.question}</span>
                    <StatusBadge status="Taught" tone="green" />
                    <button onClick={() => deleteLearningQuestion(q.id).then(refresh)} className="rounded p-1 text-ink-400 hover:text-rose-500"><Trash2 className="h-4 w-4" /></button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </>
  );
}

function TeachModal({
  q,
  agents,
  onClose,
  onTaught,
}: {
  q: LearningQuestion;
  agents: AiAgent[];
  onClose: () => void;
  onTaught: () => void;
}) {
  const [question, setQuestion] = useState(q.question);
  const [answer, setAnswer] = useState("");
  const [agentId, setAgentId] = useState(q.agentId ?? agents[0]?.id ?? "");
  const [field, setField] = useState<Field>("knowledgeBase");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!answer.trim()) { toast("Write the answer first.", "info"); return; }
    if (!agentId) { toast("Pick an agent.", "info"); return; }
    setSaving(true);
    const res = await teachAgent(q.id, agentId, field, question, answer);
    setSaving(false);
    if (!res.ok) { toast(res.message, "info"); return; }
    toast(`✅ ${res.message} It will use this from the next message.`, "success");
    onTaught();
  }

  const fieldLabels: Record<Field, string> = {
    knowledgeBase: "Knowledge base (facts the agent answers from) — recommended",
    instructions: "Instructions (what the agent should do)",
    behavior: "Behavior (how it should act / rules)",
  };

  return (
    <Modal open onClose={onClose} title="Teach the agent" subtitle={`From ${q.agentName || "an agent"} · asked ${q.timesAsked}×`} wide>
      <div className="space-y-4">
        <Field label="Question (what the patient asked)">
          <textarea rows={2} className={inputCls} value={question} onChange={(e) => setQuestion(e.target.value)} />
        </Field>
        <Field label="Answer (what the agent should say)">
          <textarea rows={4} className={inputCls} placeholder="e.g. We have 6 dentists. Dr. Leila Hariri leads implants and cosmetic dentistry…" value={answer} onChange={(e) => setAnswer(e.target.value)} />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Send to which agent">
            <select className={inputCls} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.role}</option>)}
            </select>
          </Field>
          <Field label="Add it to">
            <select className={inputCls} value={field} onChange={(e) => setField(e.target.value as Field)}>
              <option value="knowledgeBase">Knowledge base</option>
              <option value="instructions">Instructions</option>
              <option value="behavior">Behavior</option>
            </select>
          </Field>
        </div>
        <p className="text-xs text-ink-400">{fieldLabels[field]}</p>
      </div>
      <ModalFooter onClose={onClose} submitLabel={saving ? "Sending…" : "Send to agent"} onSubmit={submit} />
    </Modal>
  );
}
