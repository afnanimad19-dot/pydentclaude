import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { assertSafeUrl, makeSafeLookup, UnsafeUrlError, type Resolver, systemResolver } from "@/lib/safe-url";

// GET a user-supplied URL through the SSRF boundary in safe-url.ts:
//   • every hop (the URL and each redirect Location) is validated BEFORE any
//     request is sent — a public page can't redirect us into the network;
//   • the socket's DNS lookup is re-checked at connect time (rebinding);
//   • bounded: max redirects, timeout, response size.
// A blocked target throws UnsafeUrlError; ordinary HTTP failures are returned.

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  text: string;
  finalUrl: string;
}

export interface RawResponse {
  status: number;
  location: string | null;
  body: string;
}

export interface SafeFetchDeps {
  resolve: Resolver;
  /** One GET with no redirect handling (the transport). */
  requestOnce: (url: URL, opts: { timeoutMs: number; maxBytes: number; headers: Record<string, string> }) => Promise<RawResponse>;
}

const safeLookup = makeSafeLookup();

export function nodeRequestOnce(url: URL, opts: { timeoutMs: number; maxBytes: number; headers: Record<string, string> }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      { method: "GET", headers: { "Accept-Encoding": "gzip, deflate, br", ...opts.headers }, lookup: safeLookup as never, timeout: opts.timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location, body: "" });
        }
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
        const parts: Buffer[] = [];
        let size = 0;
        stream.on("data", (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            parts.push(c.subarray(0, Math.max(0, opts.maxBytes - (size - c.length))));
            req.destroy();
            stream.removeAllListeners("data");
            return resolve({ status, location, body: Buffer.concat(parts).toString("utf8") });
          }
          parts.push(c);
        });
        stream.on("end", () => resolve({ status, location, body: Buffer.concat(parts).toString("utf8") }));
        stream.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

const defaultDeps: SafeFetchDeps = { resolve: systemResolver, requestOnce: nodeRequestOnce };

export async function safeFetchText(
  raw: string,
  opts: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number; headers?: Record<string, string> } = {},
  deps: SafeFetchDeps = defaultDeps
): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const maxBytes = opts.maxBytes ?? 5_000_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertSafeUrl(current, deps.resolve); // throws UnsafeUrlError on any unsafe hop
    const res = await deps.requestOnce(url, { timeoutMs, maxBytes, headers: opts.headers ?? {} });
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, url).href;
      continue;
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, text: res.body, finalUrl: url.href };
  }
  throw new UnsafeUrlError("too_many_redirects", "The website redirected too many times.");
}
