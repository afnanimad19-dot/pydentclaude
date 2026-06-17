// Netlify Scheduled Function — fires every 5 minutes and asks the app to send any
// WhatsApp broadcasts whose scheduled time has arrived. The heavy lifting lives in
// /api/cron/run-broadcasts; this just pings it on a schedule.
export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "";
  if (!base) return new Response("no base url", { status: 500 });
  try {
    const res = await fetch(`${base}/api/cron/run-broadcasts`, {
      method: "POST",
      headers: { "x-cron-secret": process.env.CRON_SECRET || "" },
    });
    const body = await res.text();
    return new Response(body, { status: res.status });
  } catch (e) {
    return new Response(`cron error: ${e}`, { status: 500 });
  }
};

export const config = { schedule: "*/5 * * * *" };
