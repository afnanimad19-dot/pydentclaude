import { NextRequest, NextResponse } from "next/server";
import { getLivekitCreds, lkConfigured, lkSipDomain, lkHttpUrl, roomService, listCloudAgents, workerTokenConfigured, type CloudAgentInfo, type LivekitCreds } from "@/lib/livekit";

// Settings → LiveKit "Test connection". Proves the saved URL + API key/secret
// work by listing rooms through the server API, then lists the deployed agents
// and the SIP domain. When the saved credentials are rejected it explains
// exactly what looks wrong (format problems, project mismatch) and also tries
// the server's LIVEKIT_* env credentials, so the user learns whether the
// values in this card or the ones on the server are the good ones.
export const runtime = "nodejs";

function envCreds(): LivekitCreds | null {
  const url = (process.env.LIVEKIT_URL || "").trim();
  const apiKey = (process.env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = (process.env.LIVEKIT_API_SECRET || "").trim();
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret, agentName: (process.env.LIVEKIT_AGENT_NAME || "pydent-agent").trim(), source: "env" };
}

function diagnose(c: LivekitCreds): { urlHost: string; keyPreview: string; keyLength: number; secretLength: number; hints: string[] } {
  const hints: string[] = [];
  let urlHost = "";
  try { urlHost = new URL(lkHttpUrl(c.url)).host; } catch { hints.push(`The URL "${c.url}" is not a valid LiveKit URL — it should look like wss://your-project.livekit.cloud.`); }
  if (urlHost && !/\.livekit\.cloud$/i.test(urlHost)) hints.push(`The URL host "${urlHost}" isn't a LiveKit Cloud project host (expected something.livekit.cloud).`);
  if (/^LIVEKIT_/i.test(c.apiKey) || /=/.test(c.apiKey)) hints.push("The API key looks like a whole 'LIVEKIT_API_KEY=…' line — paste only the value after the equals sign.");
  if (!/^API/i.test(c.apiKey)) hints.push(`LiveKit API keys start with "API" (yours starts with "${c.apiKey.slice(0, 3)}") — the key and secret may be swapped.`);
  if (c.apiSecret.length < 30) hints.push("The API secret looks too short — LiveKit secrets are long (about 40+ characters). Re-paste it from LiveKit → Settings → API keys.");
  if (/\s/.test(c.apiKey) || /\s/.test(c.apiSecret)) hints.push("There is whitespace inside the key or secret.");
  return { urlHost, keyPreview: c.apiKey ? `${c.apiKey.slice(0, 6)}…` : "(empty)", keyLength: c.apiKey.length, secretLength: c.apiSecret.length, hints };
}

async function tryCreds(c: LivekitCreds): Promise<{ ok: true; rooms: number } | { ok: false; error: string }> {
  try {
    const rooms = await roomService(c).listRooms();
    return { ok: true, rooms: rooms.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "LiveKit request failed" };
  }
}

export async function POST(req: NextRequest) {
  const { ws } = await req.json().catch(() => ({}));
  const wsId = ws ? String(ws) : null;
  const creds = await getLivekitCreds(wsId);
  if (!lkConfigured(creds)) return NextResponse.json({ ok: false, error: "LiveKit isn't configured — paste the WebSocket URL, API key and API secret from your LiveKit project and save." });

  const diag = diagnose(creds);
  const primary = await tryCreds(creds);

  if (!primary.ok) {
    // Did the server's own env credentials work instead? Tells the user which set is good.
    const env = creds.source === "env" ? null : envCreds();
    let envWorks: boolean | null = null;
    let envHost = "";
    if (env) {
      const r = await tryCreds(env);
      envWorks = r.ok;
      try { envHost = new URL(lkHttpUrl(env.url)).host; } catch { /* ignore */ }
    }
    const rejected = /401|403|unauth|invalid|forbidden|permission/i.test(primary.error);
    const headline = rejected
      ? `LiveKit rejected the API key/secret saved in this card for ${diag.urlHost || creds.url}.`
      : `Could not reach LiveKit at ${creds.url} — ${primary.error}`;
    const hints = [...diag.hints];
    if (rejected && hints.length === 0) hints.push("The key and secret look well-formed, so they most likely belong to a DIFFERENT LiveKit project than this URL, or the secret was re-generated in LiveKit. In LiveKit → Settings → API keys, make sure the key is from the project whose URL is above, then paste the key and the secret again.");
    if (envWorks === true) hints.push(`Good news: the LiveKit credentials set on the server (Netlify) DO work${envHost ? ` for ${envHost}` : ""}. Easiest fix: clear the URL/key/secret in this card and Save — Pydent will use the server's values.`);
    if (envWorks === false) hints.push("The server's (Netlify) LiveKit credentials were rejected too — re-create the API key in LiveKit and update both places.");
    return NextResponse.json({ ok: false, error: headline, rawError: primary.error.slice(0, 300), diagnostics: diag, hints, envWorks });
  }

  let agents: CloudAgentInfo[] = [];
  let agentsError = "";
  try { agents = await listCloudAgents(creds); } catch (e) { agentsError = e instanceof Error ? e.message : "could not list agents"; }
  return NextResponse.json({
    ok: true,
    source: creds.source,
    rooms: primary.rooms,
    sipDomain: lkSipDomain(creds.url),
    agentName: creds.agentName,
    workerToken: await workerTokenConfigured(wsId),
    agents,
    agentsError: agentsError || undefined,
    workerDeployed: agents.some((a) => a.agentName === creds.agentName),
    diagnostics: diag,
  });
}
