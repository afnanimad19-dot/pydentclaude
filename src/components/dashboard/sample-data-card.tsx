"use client";

import { useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { Card } from "@/components/ui";
import { toast } from "@/components/toast";
import { fetchClinicSettings, saveClinicSettings } from "@/lib/db";

// Lets a real clinic switch off the built-in demo/sample data so the dashboard
// shows only their own records. Default on (keeps samples for new/demo accounts).
export function SampleDataCard() {
  const [show, setShow] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchClinicSettings().then((s) => { setShow(s.showSampleData); setLoading(false); });
  }, []);

  async function toggle() {
    const next = !show;
    setShow(next);
    setSaving(true);
    const res = await saveClinicSettings({ showSampleData: next });
    setSaving(false);
    if (!res.ok) { setShow(!next); toast(res.message, "info"); return; }
    toast(next ? "Sample data shown." : "Sample data hidden — your account now shows only real records.", "success");
  }

  return (
    <Card className="p-6">
      <h2 className="flex items-center gap-2 font-semibold text-ink-900"><FlaskConical className="h-5 w-5 text-brand-500" /> Sample data</h2>
      <p className="mt-1 text-sm text-ink-500">
        New accounts include sample conversations so the dashboard isn&apos;t empty. Turn this off to run as a real clinic —
        the inbox then shows only your own (live) conversations.
      </p>
      <div className="mt-5 flex items-center gap-3">
        <button
          onClick={toggle}
          disabled={loading || saving}
          className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${show ? "bg-brand-600" : "bg-ink-200"}`}
          title={show ? "Sample data is on" : "Sample data is off"}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${show ? "left-[22px]" : "left-0.5"}`} />
        </button>
        <span className="text-sm text-ink-600">{show ? "Showing sample data" : "Real clinic mode (sample data hidden)"}</span>
      </div>
    </Card>
  );
}
