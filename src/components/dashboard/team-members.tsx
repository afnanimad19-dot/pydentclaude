"use client";

import { useEffect, useState } from "react";
import { UsersRound, Mail, Trash2, ShieldCheck } from "lucide-react";
import { Card, StatusBadge } from "@/components/ui";
import { Field, inputCls } from "@/components/modal";
import { toast } from "@/components/toast";
import { fetchTeamMembers, inviteTeamMember, updateTeamMember, removeTeamMember, type TeamMember } from "@/lib/db";

const ROLE_HELP: Record<TeamMember["role"], string> = {
  admin: "Full access — settings, connections, agents, billing.",
  editor: "Manage patients, inbox, agents, broadcasts. No settings/billing.",
  viewer: "Read-only — can view but not change anything.",
};

export function TeamMembersPanel() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<TeamMember["role"]>("editor");
  const [busy, setBusy] = useState(false);

  function load() {
    fetchTeamMembers().then(setMembers);
  }
  useEffect(() => {
    load();
  }, []);

  async function invite() {
    if (!email.trim()) return;
    setBusy(true);
    const res = await inviteTeamMember(email, role, name);
    setBusy(false);
    toast(res.message, res.ok ? "success" : "info");
    if (res.ok) {
      setEmail("");
      setName("");
      load();
    }
  }

  return (
    <Card className="p-6">
      <h2 className="flex items-center gap-2 font-semibold text-ink-900">
        <UsersRound className="h-5 w-5 text-brand-500" /> Team members
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-500">
        Invite staff by email and choose a role. When they sign up with that email they join this clinic&apos;s
        workspace and see your data. Assign conversations to a teammate from the inbox.
      </p>

      {/* Invite */}
      <div className="mt-5 flex flex-wrap items-end gap-2 rounded-xl border border-ink-100 p-4">
        <div className="min-w-[180px] flex-1">
          <Field label="Email"><input className={inputCls} placeholder="teammate@clinic.com" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        </div>
        <div className="min-w-[140px] flex-1">
          <Field label="Name (optional)"><input className={inputCls} placeholder="Dr. Omar" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        </div>
        <div>
          <Field label="Role">
            <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value as TeamMember["role"])}>
              <option value="admin">Administrator</option>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          </Field>
        </div>
        <button onClick={invite} disabled={busy} className="flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          <Mail className="h-4 w-4" /> {busy ? "Inviting…" : "Invite"}
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-400">{ROLE_HELP[role]}</p>

      {/* List */}
      <div className="mt-5 divide-y divide-ink-100 rounded-xl border border-ink-100">
        {members.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-400">No team members yet — invite your first above.</p>
        ) : (
          members.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium text-ink-900">
                  {m.name || m.email}
                  <StatusBadge status={m.status === "active" ? "Active" : "Invited"} tone={m.status === "active" ? "green" : "amber"} />
                </p>
                {m.name && <p className="text-xs text-ink-400">{m.email}</p>}
              </div>
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1 text-xs text-ink-400"><ShieldCheck className="h-3.5 w-3.5" /></span>
                <select
                  value={m.role}
                  onChange={(e) => { updateTeamMember(m.id, { role: e.target.value as TeamMember["role"] }); setMembers((prev) => prev.map((x) => (x.id === m.id ? { ...x, role: e.target.value as TeamMember["role"] } : x))); }}
                  className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-700 outline-none"
                >
                  <option value="admin">Administrator</option>
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button onClick={() => { removeTeamMember(m.id); setMembers((prev) => prev.filter((x) => x.id !== m.id)); }} className="rounded-lg p-1.5 text-ink-400 hover:bg-rose-500/10 hover:text-rose-500">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
