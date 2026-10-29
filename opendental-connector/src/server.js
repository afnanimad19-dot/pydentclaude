// Entry point: validate configuration, pick the data layer, listen.
//
// Mode selection is EXPLICIT: the in-memory mock runs only with
// OPEN_DENTAL_MOCK=1. In live mode, missing Open Dental credentials are a
// startup failure — the connector never silently serves mock data in place of
// the clinic's real calendar. Read-only mode is ON by default
// (OPEN_DENTAL_READ_ONLY=0 to allow booking once the clinic signs off).

import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const loaded = loadConfig();
if (!loaded.ok) {
  // Names of missing variables only — never values.
  console.error("Pydent Connector cannot start — configuration problems:");
  for (const e of loaded.errors) console.error(`  * ${e}`);
  process.exit(1);
}
const config = loaded.config;

const od = config.mock
  ? await import("./mock.js")
  : (await import("./opendental.js")).createClient(config);

const app = createApp({ od, config });
app.listen(config.port, () =>
  console.log(
    `Pydent Connector listening on http://localhost:${config.port} (${config.mock ? "MOCK" : "LIVE"} mode, ${config.readOnly ? "READ-ONLY" : "read-write"})`
  )
);
