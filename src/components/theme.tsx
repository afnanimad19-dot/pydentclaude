"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

// The <html> class is the single source of truth (set pre-hydration by the
// inline script below); this store just mirrors it into React.
let listeners: (() => void)[] = [];
const subscribe = (cb: () => void) => {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
};
const getSnapshot = () => document.documentElement.classList.contains("dark");
const getServerSnapshot = () => false;

export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggle() {
    document.documentElement.classList.toggle("dark", !dark);
    localStorage.setItem("pydental-theme", !dark ? "dark" : "light");
    listeners.forEach((l) => l());
  }

  return (
    <button
      onClick={toggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="rounded-xl p-2 text-ink-500 hover:bg-ink-50"
    >
      {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
  );
}

export const themeInitScript = `
try {
  var t = localStorage.getItem("pydental-theme");
  if (t === "dark" || (!t && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.classList.add("dark");
  }
} catch (e) {}
`;
