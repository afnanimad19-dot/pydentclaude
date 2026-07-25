// Netlify Scheduled Function — the app's master heartbeat, every 10 minutes.
// Pings /api/cron/run, which drives everything time-based that isn't a
// broadcast or an IG publish: scheduled AI-team autopilot tasks, workflow
// wait-node resumes, scheduled workflows (weekly digests etc.), and the ads
// autopilot. Without this ping those features save to the DB but never fire.
export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "";
  if (!base) return new Response("no base url", { status: 500 });
  try {
    const res = await fetch(`${base}/api/cron/run`, {
      method: "GET",
      headers: { "x-cron-secret": process.env.CRON_SECRET || "" },
    });
    const body = await res.text();
    return new Response(body, { status: res.status });
  } catch (e) {
    return new Response(`cron error: ${e}`, { status: 500 });
  }
};

export const config = { schedule: "*/10 * * * *" };
