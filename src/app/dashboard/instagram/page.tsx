"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, ChevronLeft, ChevronRight, Image as ImageIcon, Clock, Pencil, Trash2, Send, UploadCloud, Sparkles, Check, X } from "lucide-react";
import { Card, PageHeader, LiveBanner, StatusBadge } from "@/components/ui";
import { Modal, Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchIgPosts, createIgPost, updateIgPost, deleteIgPost, fetchConnections, getWorkspaceId, type IgPost } from "@/lib/db";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// The platforms the Content Calendar can auto-publish to today.
const PLATFORMS: { id: string; label: string; short: string; color: string; needs: RegExp }[] = [
  { id: "instagram", label: "Instagram", short: "IG", color: "#E1306C", needs: /instagram|meta|facebook/i },
  { id: "facebook", label: "Facebook", short: "FB", color: "#1877F2", needs: /facebook|meta/i },
];

function PlatformDot({ short, color }: { short: string; color: string }) {
  return <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold text-white" style={{ background: color }}>{short}</span>;
}

const HASHTAG_SUGGESTIONS = ["#dentist", "#dentalclinic", "#smilemakeover", "#teethwhitening", "#invisalign", "#dentalimplants", "#veneers", "#oralhealth", "#dentalcare", "#cosmeticdentistry"];

function monthDays(year: number, month: number): (string | null)[] {
  const first = new Date(Date.UTC(year, month, 1));
  const startPad = (first.getUTCDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (string | null)[] = Array(startPad).fill(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

const statusTone = (s: IgPost["status"]): "green" | "red" | "blue" | "gray" =>
  s === "Published" ? "green" : s === "Failed" ? "red" : s === "Scheduled" ? "blue" : "gray";

export default function ContentCalendarPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [posts, setPosts] = useState<IgPost[]>([]);
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [modalDate, setModalDate] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<IgPost | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(() => { fetchIgPosts().then(setPosts); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    fetchConnections().then((cs) => {
      const on = new Set<string>();
      for (const p of PLATFORMS) if (cs.some((c) => p.needs.test(c.provider) && c.status !== "disconnected")) on.add(p.id);
      setConnected(on);
    });
  }, []);

  async function removePost(p: IgPost) {
    if (!confirm(`Delete this ${p.status.toLowerCase()} post?`)) return;
    setPosts((prev) => prev.filter((x) => x.id !== p.id));
    const res = await deleteIgPost(p.id);
    toast(res.message, res.ok ? "success" : "info");
    if (!res.ok) refresh();
  }

  async function publishNow(p: IgPost) {
    setBusyId(p.id);
    const ws = await getWorkspaceId();
    const res = await fetch("/api/social/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ postId: p.id, ws }) });
    const j = await res.json().catch(() => ({}));
    setBusyId(null);
    toast(j.ok ? `Published: ${j.detail}` : `Publish failed: ${j.detail ?? j.error ?? "error"}`, j.ok ? "success" : "info");
    refresh();
  }

  function shiftMonth(delta: number) {
    let m = month + delta, y = year;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setMonth(m); setYear(y);
  }

  const cells = monthDays(year, month);
  const byDate = posts.reduce<Record<string, IgPost[]>>((acc, p) => { (acc[p.scheduledFor] ??= []).push(p); return acc; }, {});

  return (
    <>
      {(modalOpen || modalDate || editing) && (
        <ComposerModal
          date={modalDate}
          fallbackDate={`${year}-${String(month + 1).padStart(2, "0")}-01`}
          editing={editing}
          connected={connected}
          onClose={() => { setModalOpen(false); setModalDate(null); setEditing(null); }}
          onSaved={refresh}
        />
      )}
      <LiveBanner context="Scheduled posts auto-publish at the chosen time. Instagram & Facebook publishing goes live once your Meta app is approved (Live) and the Page/IG account is connected." />
      <PageHeader
        title="Content Calendar"
        subtitle="Plan, create and schedule posts across your social platforms — attach media, write the caption, pick the networks, and it publishes automatically."
        actions={
          <button onClick={() => setModalOpen(true)} className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" /> Create post
          </button>
        }
      />

      {/* Connected platforms */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">Publishing to</span>
          {PLATFORMS.map((p) => {
            const on = connected.has(p.id);
            return (
              <span key={p.id} className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${on ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600" : "border-ink-200 text-ink-400"}`}>
                <PlatformDot short={p.short} color={p.color} /> {p.label} {on ? <Check className="h-3 w-3" /> : <span className="text-ink-400">— connect</span>}
              </span>
            );
          })}
          <span className="text-xs text-ink-400">Connect more in Settings → Connections.</span>
        </div>
      </Card>

      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold text-ink-900">{MONTHS[month]} {year}</h2>
          <div className="flex gap-1">
            <button onClick={() => shiftMonth(-1)} className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-50"><ChevronLeft className="h-5 w-5" /></button>
            <button onClick={() => shiftMonth(1)} className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-50"><ChevronRight className="h-5 w-5" /></button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-ink-200 bg-ink-200">
          {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => (
            <div key={d} className="bg-ink-50 px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-ink-500">{d}</div>
          ))}
          {cells.map((date, i) => (
            <div key={i} onClick={() => date && setModalDate(date)} className={`min-h-24 bg-surface p-1.5 ${date ? "cursor-pointer hover:bg-ink-50" : "bg-ink-50/50"}`}>
              {date && (
                <>
                  <p className="px-1 text-xs font-medium text-ink-400">{Number(date.slice(8))}</p>
                  <div className="mt-1 space-y-1">
                    {(byDate[date] ?? []).map((p) => (
                      <div key={p.id} onClick={(e) => { e.stopPropagation(); setEditing(p); }}
                        className={`flex cursor-pointer items-center gap-1 truncate rounded-md px-1.5 py-1 text-[11px] font-medium ${
                          p.status === "Published" ? "bg-emerald-500/15 text-emerald-600" : p.status === "Failed" ? "bg-rose-500/15 text-rose-600" : p.status === "Scheduled" ? "bg-brand-500/15 text-brand-600 dark:text-brand-300" : "bg-ink-100 text-ink-500"}`}
                        title={p.caption}>
                        {p.mediaUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.mediaUrl} alt="" className="h-3.5 w-3.5 shrink-0 rounded object-cover" />
                        ) : <Clock className="h-2.5 w-2.5 shrink-0" />}
                        <span className="truncate">{p.time} · {p.caption || p.mediaName || "Post"}</span>
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
        <h2 className="mb-4 font-semibold text-ink-900">All posts</h2>
        {posts.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">Nothing yet — click any day on the calendar or the Create post button.</p>
        ) : (
          <ul className="space-y-2.5">
            {posts.map((p) => (
              <li key={p.id} className={`flex items-center gap-3 rounded-xl border border-ink-100 px-4 py-3 ${busyId === p.id ? "opacity-50" : ""}`}>
                {p.mediaUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.mediaUrl} alt="" className="h-11 w-11 shrink-0 rounded-lg border border-ink-100 object-cover" />
                ) : (
                  <div className="rounded-lg bg-brand-500/15 p-2 text-brand-500"><ImageIcon className="h-4 w-4" /></div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900">{p.caption || "(no caption)"}</p>
                  <p className="flex items-center gap-2 text-xs text-ink-400">
                    <span>{p.scheduledFor} at {p.time}</span>
                    <span className="flex items-center gap-1">
                      {PLATFORMS.filter((pl) => p.platforms.includes(pl.id)).map((pl) => <PlatformDot key={pl.id} short={pl.short} color={pl.color} />)}
                    </span>
                  </p>
                </div>
                <StatusBadge status={p.status} tone={statusTone(p.status)} />
                {p.status !== "Published" && (
                  <button onClick={() => publishNow(p)} disabled={busyId === p.id} className="rounded-lg p-1.5 text-ink-400 hover:bg-brand-500/10 hover:text-brand-600" title="Publish now"><Send className="h-4 w-4" /></button>
                )}
                <button onClick={() => setEditing(p)} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700" title="Edit"><Pencil className="h-4 w-4" /></button>
                <button onClick={() => removePost(p)} className="rounded-lg p-1.5 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500" title="Delete"><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function ComposerModal({ date, fallbackDate, editing, connected, onClose, onSaved }: {
  date: string | null;
  fallbackDate: string;
  editing: IgPost | null;
  connected: Set<string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [caption, setCaption] = useState(editing?.caption ?? "");
  const [mediaUrl, setMediaUrl] = useState(editing?.mediaUrl ?? "");
  const [platforms, setPlatforms] = useState<string[]>(editing?.platforms ?? ["instagram"]);
  const [scheduledFor, setScheduledFor] = useState(editing?.scheduledFor ?? date ?? fallbackDate);
  const [time, setTime] = useState(editing?.time ?? "10:00");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const togglePlatform = (id: string) => setPlatforms((ps) => (ps.includes(id) ? ps.filter((x) => x !== id) : [...ps, id]));
  const addHashtag = (h: string) => setCaption((c) => (c.includes(h) ? c : `${c}${c && !c.endsWith(" ") ? " " : ""}${h}`));

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast("Attach an image file.", "info"); return; }
    setUploading(true);
    const ws = await getWorkspaceId();
    const fd = new FormData();
    fd.append("file", file);
    fd.append("ws", ws ?? "");
    const res = await fetch("/api/social/upload", { method: "POST", body: fd });
    const j = await res.json().catch(() => ({}));
    setUploading(false);
    if (j.ok && j.url) { setMediaUrl(j.url); toast("Media uploaded.", "success"); }
    else toast(j.error ?? "Upload failed — you can paste a public image URL instead.", "info");
  }

  async function save(status: IgPost["status"]) {
    if (!caption.trim() && !mediaUrl.trim()) { setResult({ ok: false, message: "Add a caption or media." }); return; }
    if (platforms.length === 0) { setResult({ ok: false, message: "Pick at least one platform." }); return; }
    setSaving(true);
    const payload = { caption, mediaName: "", mediaUrl, platforms, scheduledFor, time, status };
    const res = editing ? await updateIgPost(editing.id, payload) : await createIgPost(payload);
    setSaving(false);
    setResult(res);
    if (res.ok) { onSaved(); if (status !== "Draft") onClose(); }
  }

  return (
    <Modal open onClose={onClose} title={editing ? "Edit post" : "Create post"} subtitle="Attach media, write your caption, choose the platforms and when it goes out.">
      {result && <div className={`mb-4 rounded-xl border px-4 py-3 text-sm ${result.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600" : "border-amber-500/30 bg-amber-500/10 text-amber-600"}`}>{result.message}</div>}
      <div className="grid gap-4">
        {/* Media */}
        <Field label="Media">
          {mediaUrl ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={mediaUrl} alt="Media" className="h-20 w-20 rounded-lg border border-ink-200 object-cover" />
              <button onClick={() => setMediaUrl("")} className="flex items-center gap-1 text-xs font-medium text-rose-500 hover:text-rose-600"><X className="h-3.5 w-3.5" /> Remove</button>
            </div>
          ) : (
            <div className="space-y-2">
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-ink-200 px-4 py-5 text-sm text-ink-500 hover:border-brand-400 hover:text-brand-600">
                <UploadCloud className="h-5 w-5" /> {uploading ? "Uploading…" : "Drop or choose an image to upload"}
                <input type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} disabled={uploading} />
              </label>
              <input className={inputCls} placeholder="…or paste a public image URL" value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} />
              <p className="flex items-center gap-1 text-xs text-ink-400"><Sparkles className="h-3 w-3" /> Leave empty and an on-brand image is generated automatically at publish time.</p>
            </div>
          )}
        </Field>

        {/* Caption + hashtags */}
        <Field label="Caption">
          <textarea rows={3} className={inputCls} placeholder="✨ Before & after: porcelain veneers by Dr. Gomez. Book your consult — link in bio!" value={caption} onChange={(e) => setCaption(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          {HASHTAG_SUGGESTIONS.map((h) => (
            <button key={h} onClick={() => addHashtag(h)} className="rounded-full border border-ink-200 px-2.5 py-1 text-xs text-ink-500 hover:border-brand-400 hover:text-brand-600">{h}</button>
          ))}
        </div>

        {/* Platforms */}
        <Field label="Post to">
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((p) => {
              const on = platforms.includes(p.id);
              const isConn = connected.has(p.id);
              return (
                <button key={p.id} onClick={() => togglePlatform(p.id)} className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium ${on ? "border-brand-500 bg-brand-500/10 text-brand-600" : "border-ink-200 text-ink-500 hover:bg-ink-50"}`}>
                  <PlatformDot short={p.short} color={p.color} /> {p.label}
                  {on && <Check className="h-3.5 w-3.5" />}
                  {!isConn && <span className="text-[10px] text-ink-400">(connect)</span>}
                </button>
              );
            })}
          </div>
        </Field>

        {/* When */}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Date"><input type="date" className={inputCls} value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} /></Field>
          <Field label="Time"><input type="time" className={inputCls} value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm font-medium text-ink-500 hover:bg-ink-50">Cancel</button>
        <button onClick={() => save("Draft")} disabled={saving} className="rounded-xl border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50 disabled:opacity-50">Save draft</button>
        <button onClick={() => save("Scheduled")} disabled={saving} className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{saving ? "Saving…" : editing ? "Save & schedule" : "Schedule post"}</button>
      </div>
    </Modal>
  );
}
