// A7 authorization probe — PURE tests. fetch is ALWAYS an injected fake; no
// real network anywhere; only obvious fake fixture secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const { A7_PROJECT_REF, A7_SUPABASE_URL, FORBIDDEN_PRODUCTION_REF, A7GuardError } = await import("@/lib/a7-guard");
const { A7SentinelGuardError } = await import("@/lib/a7-sentinel-guard");
const {
  A7_AUTHORIZE_CONFIRMATION_PHRASE,
  A7_LIVE_CONFIRMATION_PHRASE,
  A7_QUERY_ENDPOINT,
  parseEnvA7,
  runA7AuthorizationProbe,
  A7RunnerError,
} = await import("../scripts/a7-mutate-lib.ts");
const { createSentinelReadTransport } = await import("../scripts/a7-live-transport.ts");
const { parseAuthorizeCliArgs } = await import("../scripts/a7-authorize.ts");

const root = path.resolve(import.meta.dirname, "..");
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

// Fake fixtures only.
const FAKE_SENTINEL = "11111111-2222-4333-8444-555555555555";
const FAKE_MGMT = "sbp_FAKE_fixture_management_token_000";
const CONFIRM = A7_AUTHORIZE_CONFIRMATION_PHRASE;

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

const makeFakeEndpoint = ({ dbToken = FAKE_SENTINEL, failQuery = false } = {}) => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (failQuery) return { ok: false, status: 500, text: async () => `ERROR Bearer ${FAKE_MGMT}`, json: async () => ({}) };
    const body = JSON.parse(init.body);
    const digest = body.parameters?.[0];
    return {
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => [{ row_count: 1, id_ok: true, ref_ok: true, token_ok: digest === sha256hex(dbToken.toLowerCase()) }],
    };
  };
  fetchImpl.requests = requests;
  return fetchImpl;
};

const probeDeps = (fetchImpl, overrides = {}) => ({
  confirmation: CONFIRM,
  env: fakeEnv(),
  executeSentinelQuery: createSentinelReadTransport(overrides.env ?? fakeEnv(), fetchImpl).executeSentinelQuery,
  ...overrides,
});

test("probe succeeds with a valid mocked sentinel: exactly one request, read_only:true, zero mutations", async () => {
  const fetchImpl = makeFakeEndpoint();
  const result = await runA7AuthorizationProbe(probeDeps(fetchImpl));
  assert.deepEqual(result, { eligible: true, ref: A7_PROJECT_REF });
  assert.equal(fetchImpl.requests.length, 1, "exactly one HTTP request");
  const { url, init } = fetchImpl.requests[0];
  assert.equal(url, A7_QUERY_ENDPOINT);
  const body = JSON.parse(init.body);
  assert.equal(body.read_only, true, "the one request is read-only");
  assert.ok(!("read_only" in body) || body.read_only === true);
  // The read transport has NO mutation member at all — structural, not gated.
  const t = createSentinelReadTransport(fakeEnv(), fetchImpl);
  assert.deepEqual(Object.keys(t), ["executeSentinelQuery"]);
  assert.equal(t.executeMutation, undefined);
});

test("absent or wrong probe confirmation refuses BEFORE fetch; mutation phrase does not satisfy it", async () => {
  for (const confirmation of [undefined, "", "yes", CONFIRM.toLowerCase(), CONFIRM + " ", A7_LIVE_CONFIRMATION_PHRASE]) {
    const fetchImpl = makeFakeEndpoint();
    await assert.rejects(
      runA7AuthorizationProbe(probeDeps(fetchImpl, { confirmation })),
      (e) => e instanceof A7RunnerError && e.code === "AUTHORIZE_CONFIRMATION_REQUIRED",
      String(confirmation),
    );
    assert.equal(fetchImpl.requests.length, 0);
  }
  assert.notEqual(A7_AUTHORIZE_CONFIRMATION_PHRASE, A7_LIVE_CONFIRMATION_PHRASE, "phrases are distinct");
});

test("production / wrong ref / wrong URL / missing A7_MODE / token problems refuse BEFORE fetch", async () => {
  const cases = [
    [{ NEXT_PUBLIC_SUPABASE_URL: `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co` }, A7GuardError, "PRODUCTION_TARGET_BLOCKED"],
    [{ DATABASE_URL: `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co` }, A7GuardError, "PRODUCTION_TARGET_BLOCKED"],
    [{ A7_EXPECTED_REF: "abcdefghij0123456789" }, A7GuardError, "EXPECTED_REF_MISMATCH"],
    [{ NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghij0123456789.supabase.co" }, A7GuardError, "REF_MISMATCH"],
    [{ NEXT_PUBLIC_SUPABASE_URL: "not a url" }, A7GuardError, "SUPABASE_URL_MALFORMED"],
    [{ A7_MODE: undefined }, A7GuardError, "A7_MODE_MISSING"],
    [{ A7_SENTINEL_TOKEN: undefined }, A7SentinelGuardError, "SENTINEL_TOKEN_MISSING"],
    [{ A7_SENTINEL_TOKEN: "not-a-uuid" }, A7SentinelGuardError, "SENTINEL_TOKEN_MALFORMED"],
  ];
  for (const [patch, Err, code] of cases) {
    const fetchImpl = makeFakeEndpoint();
    // Mock executor keeps construction out of the way; fetch counter still proves no network.
    const deps = {
      confirmation: CONFIRM,
      env: { ...fakeEnv(), ...patch },
      executeSentinelQuery: createSentinelReadTransport(fakeEnv(), fetchImpl).executeSentinelQuery,
    };
    await assert.rejects(runA7AuthorizationProbe(deps), (e) => e instanceof Err && e.code === code, code);
    assert.equal(fetchImpl.requests.length, 0, `${code}: no fetch`);
  }
});

test("sentinel mismatch and sentinel query failure fail closed (after exactly one read-only request)", async () => {
  const mismatch = makeFakeEndpoint({ dbToken: "99999999-8888-4777-a666-555555555544" });
  await assert.rejects(
    runA7AuthorizationProbe(probeDeps(mismatch)),
    (e) => e instanceof A7SentinelGuardError && e.code === "SENTINEL_TOKEN_MISMATCH",
  );
  assert.equal(mismatch.requests.length, 1);
  assert.equal(JSON.parse(mismatch.requests[0].init.body).read_only, true);

  const failing = makeFakeEndpoint({ failQuery: true });
  await assert.rejects(
    runA7AuthorizationProbe(probeDeps(failing)),
    (e) => e instanceof A7SentinelGuardError && e.code === "SENTINEL_QUERY_FAILED",
  );
  assert.equal(failing.requests.length, 1);
});

test("authorize CLI accepts ONLY --confirm=<exact phrase>: no steps, SQL, refs, URLs, or endpoints", () => {
  assert.deepEqual(parseAuthorizeCliArgs([`--confirm=${CONFIRM}`]), { confirmation: CONFIRM });
  const refuse = (argv, code) =>
    assert.throws(() => parseAuthorizeCliArgs(argv), (e) => e instanceof A7RunnerError && e.code === code, argv.join(" "));
  refuse([], "INVALID_ARGS");
  refuse(["--confirm=wrong"], "AUTHORIZE_CONFIRMATION_REQUIRED");
  refuse([`--confirm=${A7_LIVE_CONFIRMATION_PHRASE}`], "AUTHORIZE_CONFIRMATION_REQUIRED"); // mutation phrase rejected
  refuse(["baseline-0001-0064", `--confirm=${CONFIRM}`], "INVALID_ARGS"); // no step argument exists
  refuse([`--confirm=${CONFIRM}`, "apply-0065"], "INVALID_ARGS");
  refuse(["--sql=drop table x"], "INVALID_ARGS");
  refuse(["select 1;"], "INVALID_ARGS");
  refuse([`--ref=${FORBIDDEN_PRODUCTION_REF}`], "INVALID_ARGS");
  refuse(["--url=https://evil.example"], "INVALID_ARGS");
  refuse(["--endpoint=https://api.supabase.com/v1/projects/x/database/query"], "INVALID_ARGS");
  refuse([`--confirm=${CONFIRM}`, `--confirm=${CONFIRM}`], "INVALID_ARGS");
});

test("probe is structurally read-only: no migration reads, no mutation symbols, no manifest", () => {
  // Scan CODE only: strip comments and string literals so documentation prose
  // (which names the forbidden symbols to say they are absent) cannot match.
  const cliSrc = fs
    .readFileSync(path.join(root, "scripts", "a7-authorize.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
  for (const forbidden of ["runLiveStep", "executeMutation", "createLiveTransport", "A7_STEPS", "a7-manifest", "migrations", "readSql", "readDisk"]) {
    assert.ok(!cliSrc.includes(forbidden), `a7-authorize.ts code must not reference ${forbidden}`);
  }
  // The probe deps type carries no step/mutation/file capability; the lib
  // function only consumes confirmation+env+read executor (behavioral proof:
  // a deps object with extra mutation-looking fields is simply never called).
  const spy = { called: 0 };
  return runA7AuthorizationProbe({
    confirmation: CONFIRM,
    env: fakeEnv(),
    executeSentinelQuery: async () => [{ row_count: 1, id_ok: true, ref_ok: true, token_ok: false }],
    executeMutation: () => { spy.called++; }, // ignored extra prop — nothing in the probe can reach it
  }).catch(() => {
    assert.equal(spy.called, 0, "no mutation capability is ever invoked");
  });
});

test("no secrets in probe success or failure output (token, digest, mgmt token, Authorization)", async () => {
  const digest = sha256hex(FAKE_SENTINEL.toLowerCase());
  const outputs = [];
  outputs.push(JSON.stringify(await runA7AuthorizationProbe(probeDeps(makeFakeEndpoint()))));
  for (const deps of [
    probeDeps(makeFakeEndpoint(), { confirmation: "nope" }),
    probeDeps(makeFakeEndpoint({ dbToken: "99999999-8888-4777-a666-555555555544" })),
    probeDeps(makeFakeEndpoint({ failQuery: true })),
  ]) {
    try {
      await runA7AuthorizationProbe(deps);
    } catch (e) {
      outputs.push(`${e.message} ${e.stack ?? ""}`);
    }
  }
  for (const text of outputs) {
    assert.ok(!text.includes(FAKE_SENTINEL), "raw sentinel token leaked");
    assert.ok(!text.includes(digest), "sentinel digest leaked");
    assert.ok(!text.includes(FAKE_MGMT), "management token leaked");
    // Header material: the literal header form or any Bearer value. (The bare
    // word "Authorization" appears legitimately in function names/stacks.)
    assert.ok(!/Authorization['"]?\s*:|Bearer\s+\S+/.test(text), "Authorization header material leaked");
  }
});

test("dry-run stays zero-network and the app runtime imports none of the probe", () => {
  for (const file of ["scripts/a7-mutate-lib.ts", "scripts/a7-mutate.ts", "scripts/a7-manifest.ts"]) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(src, /fetch\s*\(|node:https?|XMLHttpRequest|axios|undici/, file);
    assert.doesNotMatch(src, /from\s+["'][^"']*(a7-live-transport|a7-mutate-live|a7-authorize)/, file);
  }
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(p);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        assert.doesNotMatch(fs.readFileSync(p, "utf8"), /a7-authorize|a7-mutate|a7-manifest|a7-live-transport/, p);
      }
    }
  };
  scan(path.join(root, "src"));
});
