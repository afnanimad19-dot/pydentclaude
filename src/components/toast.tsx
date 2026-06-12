"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Info } from "lucide-react";

// Tiny toast system: call toast("...") from anywhere; <Toaster /> renders them.

type ToastKind = "success" | "info";
interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

export function toast(message: string, kind: ToastKind = "success") {
  window.dispatchEvent(new CustomEvent("pydental-toast", { detail: { message, kind } }));
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    function onToast(e: Event) {
      const { message, kind } = (e as CustomEvent).detail;
      const id = Date.now() + Math.random();
      setItems((prev) => [...prev, { id, message, kind }]);
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4200);
    }
    window.addEventListener("pydental-toast", onToast);
    return () => window.removeEventListener("pydental-toast", onToast);
  }, []);

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-[100] flex w-80 flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-ink-200 bg-surface px-4 py-3 text-sm text-ink-800 shadow-xl"
        >
          {t.kind === "success" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          ) : (
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
          )}
          <span className="leading-snug">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
