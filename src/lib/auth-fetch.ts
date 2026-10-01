import { supabase } from "./supabase";

// Browser fetch that carries the signed-in user's Supabase access token, for
// API routes that authorize server-side (lib/server-auth.ts). The server
// derives the workspace from this token — never from anything the page sends.
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers = new Headers(init.headers ?? {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  // JSON bodies get a JSON content type; FormData must keep the browser's own
  // multipart boundary header, so it is never overridden.
  const isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
  if (init.body && !isForm && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(input, { ...init, headers });
}

/** A fresh idempotency key for one user action (retries of the SAME action reuse it). */
export function newIdempotencyKey(prefix = "act"): string {
  const r = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${r}`;
}
