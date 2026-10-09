// A7 live transport + live CLI gating — PURE tests. fetch is ALWAYS a mock
// (createLiveTransport takes an injected fetchImpl); no real network requests
// occur anywhere in this file, and only obvious fake fixture secrets are used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const { A7_PROJECT_REF, A7_SUPABASE_URL, FORBIDDEN_PRODUCTION_REF, A7GuardError } = await import("@/lib/a7-guard");
const { A7SentinelGuardError, SENTINEL_VERIFICATION_SQL } = await import("@/lib/a7-sentinel-guard");
const { A7_STEPS, A7_QUERY_ENDPOINT, A7_LIVE_CONFIRMATION_PHRASE, parseEnvA7, runLiveStep, A7RunnerError } =
  await import("../scripts/a7-mutate-lib.ts");
const { createLiveTransport, scrubTransportText } = await import("../scripts/a7-live-transport.ts");
const { parseLiveCliArgs } = await import("../scripts/a7-mutate-live.ts");

const root = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(root, "supabase", "migrations");
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

// Fake fixtures only — never real secrets.
const FAKE_SENTINEL = "11111111-2222-4333-8444-555555555555";
const FAKE_MGMT = "sbp_FAKE_fixture_management_token_000";
const CONFIRM = A7_LIVE_CONFIRMATION_PHRASE;

const fakeEnv = () =>
  parseEnvA7(
    [
      "A7_MODE=1",
      `A7_EXPECTED_REF=${A7_PROJECT_REF}`,
      `NEXT_PUBLIC_SUPABASE_URL=${A7_SUPABASE_URL}`,
      `A7_SENTINEL_TOKEN=${FAKE_SENTINEL}`,
      `A7_SUPABASE_MGMT_TOKEN=${FAKE_MGMT}`,
    ].join("\n"),
  );

const realDisk = () =>
  fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(path.join(migrationsDir, file))).digest("hex") }));

/** Fake Supabase query endpoint: records requests, answers like the real one. */
const makeFakeEndpoint = ({ failOnFile = null, httpStatus = 400, dbToken = FAKE_SENTINEL } = {}) => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const body = JSON.parse(init.body);
    if (body.read_only === true) {
      const digest = body.parameters?.[0];
      return {
        ok: true,
        status: 201,
        text: async () => "",
        json: async () => [{ row_count: 1, id_ok: true, ref_ok: true, token_ok: digest === sha256hex(dbToken.toLowerCase()) }],
      };
    }
    const file = requests.at(-1).file ?? null; // not used; failure keyed on SQL marker below
    if (failOnFile !== null && body.query.includes(`--file:${failOnFile}`)) {
      return { ok: false, status: httpStatus, text: async () => `ERROR: boom Bearer ${FAKE_MGMT} token ${FAKE_SENTINEL}`, json: async () => ({}) };
    }
    return { ok: true, status: 201, text: async () => "", json: async () => [] };
  };
  fetchImpl.requests = requests;
  return fetchImpl;
};

test("live CLI args: exact phrase required; no SQL/paths/refs/flags accepted", () => {
  assert.deepEqual(parseLiveCliArgs(["apply-0065", `--confirm=${CONFIRM}`]), { stepId: "apply-0065", confirmation: CONFIRM });
  const refuse = (argv, code) =>
    assert.throws(() => parseLiveCliArgs(argv), (e) => e instanceof A7RunnerError && e.code === code, argv.join(" "));
  refuse(["apply-0065"], "LIVE_CONFIRMATION_REQUIRED"); // step without phrase
  refuse(["apply-0065", "--confirm=yes"], "LIVE_CONFIRMATION_REQUIRED"); // wrong phrase
  refuse(["apply-0065", `--confirm=${CONFIRM.toLowerCase()}`], "LIVE_CONFIRMATION_REQUIRED"); // case matters
  refuse([`--confirm=${CONFIRM}`], "INVALID_ARGS"); // phrase without step
  refuse(["apply-0065", `--confirm=${CONFIRM}`, "apply-0066"], "INVALID_ARGS"); // no chaining
  refuse(["--sql", "drop table x", `--confirm=${CONFIRM}`], "INVALID_ARGS");
  refuse(["apply-0065", `--confirm=${CONFIRM}`, "--live"], "INVALID_ARGS");
  refuse(["not-a-step", `--confirm=${CONFIRM}`], "UNKNOWN_STEP");
  refuse([FORBIDDEN_PRODUCTION_REF, `--confirm=${CONFIRM}`], "UNKNOWN_STEP");
  refuse(["supabase/migrations/0001_init.sql", `--confirm=${CONFIRM}`], "UNKNOWN_STEP");
});

test("transport pins the A7 endpoint, sends Authorization only as a header, never in the URL", async () => {
  const fetchImpl = makeFakeEndpoint();
  const t = createLiveTransport(fakeEnv(), fetchImpl);
  await t.executeSentinelQuery(SENTINEL_VERIFICATION_SQL, [sha256hex(FAKE_SENTINEL.toLowerCase())]);
  await t.executeMutation("select 1 --file:x.sql", "x.sql", { eligible: true, ref: A7_PROJECT_REF, sentinel: { id: 1, projectRef: A7_PROJECT_REF } });
  assert.equal(fetchImpl.requests.length, 2);
  for (const { url, init } of fetchImpl.requests) {
    assert.equal(url, A7_QUERY_ENDPOINT);
    assert.ok(!url.includes(FAKE_MGMT) && !url.includes("token=") && !url.includes("?"), "credential never in URL/query string");
    assert.equal(init.headers.Authorization, `Bearer ${FAKE_MGMT}`); // header only
    assert.ok(!init.body.includes(FAKE_MGMT) && !init.body.includes(FAKE_SENTINEL), "no secret in request body");
  }
  assert.equal(JSON.parse(fetchImpl.requests[0].init.body).read_only, true);
  assert.equal(JSON.parse(fetchImpl.requests[1].init.body).read_only, false);
  // Mutation without a real authorization object is refused by the transport too.
  await assert.rejects(t.executeMutation("select 1", "x.sql", null), (e) => e instanceof A7RunnerError);
});

test("transport refuses construction on a non-A7 env; endpoint constant excludes production", () => {
  assert.ok(A7_QUERY_ENDPOINT.includes(A7_PROJECT_REF) && !A7_QUERY_ENDPOINT.includes(FORBIDDEN_PRODUCTION_REF));
  const bad = { ...fakeEnv(), NEXT_PUBLIC_SUPABASE_URL: `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co` };
  assert.throws(() => createLiveTransport(bad, makeFakeEndpoint()), (e) => e instanceof A7RunnerError && e.code === "CONFIG_INVALID");
  const noToken = { ...fakeEnv(), A7_SUPABASE_MGMT_TOKEN: "" };
  assert.throws(() => createLiveTransport(noToken, makeFakeEndpoint()), (e) => e instanceof A7RunnerError && e.code === "ENV_MISSING_KEY");
});

test("endpoint error text is scrubbed: no tokens, UUIDs, digests, or Bearer values survive", async () => {
  assert.equal(scrubTransportText(`Bearer ${FAKE_MGMT}`).includes(FAKE_MGMT), false);
  assert.equal(scrubTransportText(`x ${FAKE_SENTINEL} y`).includes(FAKE_SENTINEL), false);
  const digest = sha256hex("anything");
  assert.equal(scrubTransportText(`digest ${digest}`).includes(digest), false);
  assert.ok(scrubTransportText("ERROR: 42P07 relation exists").includes("42P07"), "useful PG codes survive");
  // Through the transport: a failing response embedding secrets yields a clean error.
  const fetchImpl = makeFakeEndpoint({ failOnFile: "y.sql" });
  const t = createLiveTransport(fakeEnv(), fetchImpl);
  try {
    await t.executeMutation("select 1 --file:y.sql", "y.sql", { eligible: true, ref: A7_PROJECT_REF, sentinel: { id: 1, projectRef: A7_PROJECT_REF } });
    assert.fail("expected refusal");
  } catch (e) {
    const text = `${e.message} ${e.stack ?? ""}`;
    assert.ok(e instanceof A7RunnerError && e.code === "TRANSPORT_HTTP_ERROR");
    assert.ok(text.includes("HTTP 400"), "safe status is reported");
    assert.ok(!text.includes(FAKE_MGMT) && !text.includes(FAKE_SENTINEL), "secrets scrubbed from error");
  }
});

test("full mocked live flow: static checks, guards, sentinel auth, then mutations in order; auth immediately precedes mutation", async () => {
  const events = [];
  const fetchImpl = makeFakeEndpoint();
  const t = createLiveTransport(fakeEnv(), fetchImpl);
  const result = await runLiveStep({
    confirmation: CONFIRM,
    stepId: "apply-0065",
    env: fakeEnv(),
    readDisk: realDisk,
    readSql: (f) => fs.readFileSync(path.join(migrationsDir, f), "utf8"),
    executeSentinelQuery: (sql, params) => { events.push("authorize"); return t.executeSentinelQuery(sql, params); },
    executeMutation: async (sql, file, auth) => { events.push(`mutate:${file}`); await t.executeMutation(sql, file, auth); },
  });
  assert.deepEqual(events, ["authorize", "mutate:0065_central_knowledge.sql"]);
  assert.deepEqual(result.applied, ["0065_central_knowledge.sql"]);
  // Only the selected step's migrations executed: 0066 and baseline never ran.
  assert.equal(fetchImpl.requests.length, 2); // 1 sentinel read + 1 mutation
});

test("sentinel mismatch through the real transport blocks all mutation requests", async () => {
  const fetchImpl = makeFakeEndpoint({ dbToken: "99999999-8888-4777-a666-555555555544" });
  const t = createLiveTransport(fakeEnv(), fetchImpl);
  await assert.rejects(
    runLiveStep({
      confirmation: CONFIRM,
      stepId: "apply-0065",
      env: fakeEnv(),
      readDisk: realDisk,
      readSql: (f) => fs.readFileSync(path.join(migrationsDir, f), "utf8"),
      executeSentinelQuery: t.executeSentinelQuery,
      executeMutation: t.executeMutation,
    }),
    (e) => e instanceof A7SentinelGuardError && e.code === "SENTINEL_TOKEN_MISMATCH",
  );
  assert.equal(fetchImpl.requests.length, 1, "only the read-only sentinel check ran");
  assert.equal(JSON.parse(fetchImpl.requests[0].init.body).read_only, true);
});

test("first failing migration stops the sequence; later files are not attempted or marked applied", async () => {
  const step = A7_STEPS["baseline-0001-0064"].migrations.map((m) => m.file);
  const failAt = step[2]; // third file
  const attempted = [];
  await assert.rejects(
    runLiveStep({
      confirmation: CONFIRM,
      stepId: "baseline-0001-0064",
      env: fakeEnv(),
      readDisk: realDisk,
      readSql: (f) => `--file:${f}`,
      executeSentinelQuery: async () => [{ row_count: 1, id_ok: true, ref_ok: true, token_ok: true }],
      executeMutation: async (sql, file) => {
        attempted.push(file);
        if (file === failAt) throw new A7RunnerError("TRANSPORT_HTTP_ERROR", `${file}: HTTP 400`);
      },
    }),
    (e) => e instanceof A7RunnerError && e.code === "TRANSPORT_HTTP_ERROR",
  );
  assert.deepEqual(attempted, step.slice(0, 3), "stopped exactly at the failure");
});

test("wrong ref / wrong URL / missing A7_MODE refuse before any transport call", async () => {
  const fetchImpl = makeFakeEndpoint();
  const t = createLiveTransport(fakeEnv(), fetchImpl);
  const base = {
    confirmation: CONFIRM,
    stepId: "apply-0065",
    readDisk: realDisk,
    readSql: () => "-- sql",
    executeSentinelQuery: t.executeSentinelQuery,
    executeMutation: t.executeMutation,
  };
  const good = fakeEnv();
  for (const [env, code] of [
    [{ ...good, A7_EXPECTED_REF: "abcdefghij0123456789" }, "EXPECTED_REF_MISMATCH"],
    [{ ...good, NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghij0123456789.supabase.co" }, "REF_MISMATCH"],
    [{ ...good, NEXT_PUBLIC_SUPABASE_URL: "not a url" }, "SUPABASE_URL_MALFORMED"],
    [{ ...good, A7_MODE: undefined }, "A7_MODE_MISSING"],
  ]) {
    await assert.rejects(runLiveStep({ ...base, env }), (e) => e instanceof A7GuardError && e.code === code, code);
  }
  assert.equal(fetchImpl.requests.length, 0, "no HTTP before the guards pass");
});

test("dry-run remains zero-network: its module graph contains no network code and no live CLI", () => {
  for (const file of ["scripts/a7-mutate-lib.ts", "scripts/a7-mutate.ts", "scripts/a7-manifest.ts"]) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(src, /fetch\s*\(|node:https?|XMLHttpRequest|axios|undici/, file);
    assert.doesNotMatch(src, /from\s+["'][^"']*(a7-live-transport|a7-mutate-live)/, `${file} must not import live modules`);
  }
  // Network code exists ONLY in the live transport, wired only by the live CLI.
  const liveCli = fs.readFileSync(path.join(root, "scripts", "a7-mutate-live.ts"), "utf8");
  assert.ok(liveCli.includes("a7-live-transport"));
  // The app runtime still imports none of this.
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(p);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        assert.doesNotMatch(fs.readFileSync(p, "utf8"), /a7-mutate|a7-manifest|a7-live-transport|scripts\//, p);
      }
    }
  };
  scan(path.join(root, "src"));
});

test("success and failure outputs carry no secrets (fixture-wide sweep)", async () => {
  const outputs = [];
  const fetchImpl = makeFakeEndpoint();
  const t = createLiveTransport(fakeEnv(), fetchImpl);
  outputs.push(
    JSON.stringify(
      await runLiveStep({
        confirmation: CONFIRM,
        stepId: "apply-0066",
        env: fakeEnv(),
        readDisk: realDisk,
        readSql: (f) => fs.readFileSync(path.join(migrationsDir, f), "utf8"),
        executeSentinelQuery: t.executeSentinelQuery,
        executeMutation: t.executeMutation,
      }),
    ),
  );
  const failing = createLiveTransport(fakeEnv(), makeFakeEndpoint({ failOnFile: "0066_clinic_scheduling.sql" }));
  try {
    await runLiveStep({
      confirmation: CONFIRM,
      stepId: "apply-0066",
      env: fakeEnv(),
      readDisk: realDisk,
      readSql: (f) => `--file:${f}\n` + fs.readFileSync(path.join(migrationsDir, f), "utf8"),
      executeSentinelQuery: failing.executeSentinelQuery,
      executeMutation: failing.executeMutation,
    });
  } catch (e) {
    outputs.push(`${e.message} ${e.stack ?? ""}`);
  }
  const digest = sha256hex(FAKE_SENTINEL.toLowerCase());
  for (const text of outputs) {
    assert.ok(!text.includes(FAKE_SENTINEL), "sentinel token leaked");
    assert.ok(!text.includes(FAKE_MGMT), "management token leaked");
    assert.ok(!text.includes(digest), "sentinel digest leaked");
    assert.ok(!text.includes("Authorization"), "Authorization header leaked");
  }
});
