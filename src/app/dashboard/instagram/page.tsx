"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, ChevronLeft, ChevronRight, Image as ImageIcon, Clock } from "lucide-react";
import { Card, PageHeader, DemoBanner, StatusBadge } from "@/components/ui";
import { Modal, Field, ModalFooter, inputCls } from "@/components/modal";
import { fetchIgPosts, createIgPost, type IgPost } from "@/lib/db";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function monthDays(year: number, month: number): (string | null)[] {
  const first = new Date(Date.UTC(year, month, 1));
  const startPad = (first.getUTCDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (string | null)[] = Array(startPad).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export default function InstagramPage() {
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(5); // June
  const [posts, setPosts] = useState<IgPost[]>([]);
  const [modalDate, setModalDate] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const refresh = useCallback(() => {
    fetchIgPosts().then(setPosts);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  function shiftMonth(delta: number) {
    let m = month + delta;
    let y = year;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setMonth(m);
    setYear(y);
  }

  const cells = monthDays(year, month);
  const byDate = posts.reduce<Record<string, IgPost[]>>((acc, p) => {
    (acc[p.scheduledFor] ??= []).push(p);
    return acc;
  }, {});

  return (
    <>
      {(modalOpen || modalDate) && (
        <NewPostModal
          date={modalDate}
          onClose={() => {
            setModalOpen(false);
            setModalDate(null);
          }}
          onCreated={refresh}
        />
      )}
      <DemoBanner context="Connect your Instagram account in Settings to publish for real — scheduling works now." />
      <PageHeader
        title="Instagram"
        subtitle="Content calendar — plan, create and schedule posts for the whole month."
        actions={
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" /> Create post
          </button>
        }
      />

      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold text-ink-900">
            {MONTHS[month]} {year}
          </h2>
          <div className="flex gap-1">
            <button onClick={() => shiftMonth(-1)} className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-50">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button onClick={() => shiftMonth(1)} className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-50">
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-ink-200 bg-ink-200">
          {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => (
            <div key={d} className="bg-ink-50 px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-ink-500">
              {d}
            </div>
          ))}
          {cells.map((date, i) => (
            <div
              key={i}
              onClick={() => date && setModalDate(date)}
              className={`min-h-24 bg-surface p-1.5 ${date ? "cursor-pointer hover:bg-ink-50" : "bg-ink-50/50"}`}
            >
              {date && (
                <>
                  <p className="px-1 text-xs font-medium text-ink-400">{Number(date.slice(8))}</p>
                  <div className="mt-1 space-y-1">
                    {(byDate[date] ?? []).map((p) => (
                      <div
                        key={p.id}
                        className={`truncate rounded-md px-1.5 py-1 text-[11px] font-medium ${
                          p.status === "Published"
                            ? "bg-emerald-500/15 text-emerald-600"
                            : p.status === "Scheduled"
                            ? "bg-brand-500/15 text-brand-600 dark:text-brand-300"
                            : "bg-ink-100 text-ink-500"
                        }`}
                        title={p.caption}
                      >
                        <Clock className="mr-0.5 inline h-2.5 w-2.5" /> {p.time} · {p.caption || p.mediaName}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card className="mt-6 p-5">
        <h2 className="mb-4 font-semibold text-ink-900">All scheduled posts</h2>
        {posts.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">
            Nothing scheduled yet — click any day on the calendar or the Create post button.
            (If saving fails, run migration 0004 in the Supabase SQL Editor.)
          </p>
        ) : (
          <ul className="space-y-2.5">
            {posts.map((p) => (
              <li key={p.id} className="flex items-center gap-3 rounded-xl border border-ink-100 px-4 py-3">
                <div className="rounded-lg bg-brand-500/15 p-2 text-brand-500">
                  <ImageIcon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900">{p.caption || "(no caption)"}</p>
                  <p className="text-xs text-ink-400">
                    {p.scheduledFor} at {p.time}
                    {p.mediaName && ` · ${p.mediaName}`}
                  </p>
                </div>
                <StatusBadge status={p.status} tone={p.status === "Published" ? "green" : p.status === "Scheduled" ? "blue" : "gray"} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function NewPostModal({
  date,
  onClose,
  onCreated,
}: {
  date: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [caption, setCaption] = useState("");
  const [mediaName, setMediaName] = useState("");
  const [scheduledFor, setScheduledFor] = useState(date ?? "2026-06-15");
  const [time, setTime] = useState("10:00");
  const [status, setStatus] = useState<IgPost["status"]>("Scheduled");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!caption.trim() && !mediaName.trim()) {
      setResult({ ok: false, message: "Add a caption or media." });
      return;
    }
    setSaving(true);
    const res = await createIgPost({ caption, mediaName, scheduledFor, time, status });
    setSaving(false);
    setResult(res);
    if (res.ok) onCreated();
  }

  return (
    <Modal open onClose={onClose} title="Create Instagram post" subtitle="Plan it on the calendar — publishing connects once Instagram is linked.">
      {result?.ok ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600">{result.message}</div>
      ) : (
        <>
          {result && (
            <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600">{result.message}</div>
          )}
          <div className="grid gap-4">
            <Field label="Caption">
              <textarea
                rows={3}
                className={inputCls}
                placeholder="✨ Before & after: porcelain veneers by Dr. Gomez. Link in bio to book your consult!"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
              />
            </Field>
            <Field label="Media file name (image/video)">
              <input className={inputCls} placeholder="veneers-before-after.jpg" value={mediaName} onChange={(e) => setMediaName(e.target.value)} />
            </Field>
            <div className="grid grid-cols-3 gap-4">
              <Field label="Date">
                <input type="date" className={inputCls} value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} />
              </Field>
              <Field label="Time">
                <input type="time" className={inputCls} value={time} onChange={(e) => setTime(e.target.value)} />
              </Field>
              <Field label="Status">
                <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as IgPost["status"])}>
                  <option>Scheduled</option>
                  <option>Draft</option>
                  <option>Published</option>
                </select>
              </Field>
            </div>
          </div>
          <ModalFooter onClose={onClose} submitLabel={saving ? "Saving…" : "Schedule post"} onSubmit={submit} />
        </>
      )}
    </Modal>
  );
}
