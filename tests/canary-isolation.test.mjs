// Canary isolation invariants — PURE OFFLINE source-level tests.
//   * Every existing A7 file is byte-for-byte the reviewed version (c394c23).
//   * Canary code never reads .env files, never sets an Authorization header,
//     never imports the A7 transport or guard, and contains the forbidden
//     refs ONLY in the guard's literal constants.
//   * Only the transport performs network I/O; the plan path is network-free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const sha = (p) => createHash("sha256").update(fs.readFileSync(path.join(root, p))).digest("hex");

/** SHA-256 of every A7 file at commit c394c238fe9a6d235d9b905fb57f6f613e699cd5. */
const A7_FILES = [
  ["scripts/a7-authorize.ts", "50df94b4926b686469925f5c67892c9269e43ce7ae5a1fe43f8e7d785a1cb673"],
  ["scripts/a7-live-transport.ts", "63fc261ba98ee46a835ded8534be96953de38dcff04ad715755d975c176e2da0"],
  ["scripts/a7-manifest.ts", "7b3e21c0f9c15bbb18e259a22d2390d2492cb665c3e1ab734a8aa49f3071f975"],
  ["scripts/a7-mutate-lib.ts", "86ce4b560a7b18f4cc9c55bc85719f5ea430498acc21e26cb5896a91bb9e5d2f"],
  ["scripts/a7-mutate-live.ts", "f534513b4d0d2ce49601ed1c2ab2574a550b60b262a6cd87503edd0916693cd7"],
  ["scripts/a7-mutate.ts", "c6a328bf5f52440ca48ae6da4c143238d1302713310437c409c94ae45c6f0e98"],
  ["scripts/a7-validate-0066-lib.ts", "2583fa36d160e3496f288d74b69a81a22d9dd538d4c90ea9fcda5f6b84703a8f"],
  ["scripts/a7-validate-0066.ts", "6828bb6961f70d507f3a3204f1eec4e9b13126671466751d644134a8470f171c"],
  ["scripts/a7-validate-0068-lib.ts", "f2688055e758232ac12b6f33ed3a7e9c03d77b27dd613b51b158d8645ce45f1c"],
  ["scripts/a7-validate-0068.ts", "30f513ea25ce7b8ccd057ffdfdc7cc8c9d2a8c2bc7f9ee0d6604f557f1100105"],
  ["scripts/a7-validate-2b-lib.ts", "154196bbf25d979b218410e83c61c2a01b28b19877fdd99f032e019580cd1583"],
  ["scripts/a7-validate-2b.ts", "bfd85660677eec5d587f7fcf1ce868715ed7bdba36359612092c385a5273c32d"],
  ["src/lib/a7-guard.ts", "786008a4c7e9d6b9d4f96db227254546feab9e7b879ef00243b1b942db161c02"],
  ["src/lib/a7-sentinel-guard.ts", "3829b77193dd12eaa7e33e47b1fb51e1360cadcbf9bece5fef1cae159b64556f"],
  ["tests/a7-authorize.test.mjs", "1e99a90a4083413c7df0036d19ece987758ba4672a6e154d0d5fa51f9c5e5efd"],
  ["tests/a7-grants-0067.test.mjs", "b2f90d6f493fc75810a41219dc1ffa3f9e74b65918dc0d69ccf5fbfd0707982a"],
  ["tests/a7-guard.test.mjs", "84204871894c1975cc2f317333e6a770208ca5aad72f8d02ef1ae60cf8835222"],
  ["tests/a7-live-runner.test.mjs", "6c58524673bc66efa74254fe5d5dac0fec716b0383e0d57700a419214c9c99bd"],
  ["tests/a7-mutation-runner.test.mjs", "bbab2b3e65fd1db18a144ea56bda371887d11a5049c6a10e7b66642ae720adbe"],
  ["tests/a7-sentinel-guard.test.mjs", "34d6bbaef641c3d3e9b11c1a6f609a0517c09b8d0239104bd0e0ab0bf1df428a"],
  ["tests/a7-validate-0066.test.mjs", "a3ff6c5ef208d7f73191970ffd30cbb7ed392f3df9d57e21f02a7d21eb8a6c6a"],
  ["tests/a7-validate-0068.test.mjs", "931b41326e67205c26859f0998ad76a2b21d60f2110f5964739a7001174b359d"],
  ["tests/a7-validate-2b.test.mjs", "787e2647718bd39da9322f0ff1bbb8fea6afe489e298572304624c3c8cce4012"],
];

test("every existing A7 file is byte-for-byte the reviewed version", () => {
  const onDisk = [
    ...fs.readdirSync(path.join(root, "scripts")).filter((f) => f.startsWith("a7-")).map((f) => `scripts/${f}`),
    ...fs.readdirSync(path.join(root, "src/lib")).filter((f) => f.startsWith("a7-")).map((f) => `src/lib/${f}`),
    ...fs.readdirSync(path.join(root, "tests")).filter((f) => f.startsWith("a7-")).map((f) => `tests/${f}`),
  ].sort();
  assert.deepEqual(onDisk, A7_FILES.map(([f]) => f).sort(), "no A7 file added or removed");
  for (const [file, hash] of A7_FILES) assert.equal(sha(file), hash, file);
});

const canaryScripts = fs.readdirSync(path.join(root, "scripts")).filter((f) => f.startsWith("canary-")).map((f) => `scripts/${f}`);

test("the canary tooling is exactly the expected set of files", () => {
  assert.deepEqual(canaryScripts.sort(), [
    "scripts/canary-guard.ts",
    "scripts/canary-manifest-check.ts",
    "scripts/canary-plan-lib.ts",
    "scripts/canary-plan.ts",
    "scripts/canary-preflight-lib.ts",
    "scripts/canary-preflight.ts",
    "scripts/canary-probe-lib.ts",
    "scripts/canary-probe.ts",
    "scripts/canary-sentinel.ts",
    "scripts/canary-transport.ts",
  ]);
});

test("canary code never reads .env files, never sets Authorization, never uses A7 transport/guard", () => {
  for (const f of canaryScripts) {
    const src = read(f);
    assert.doesNotMatch(src, /readFileSync\([^)]*\.env/, `${f}: reads an .env file`);
    assert.doesNotMatch(src, /\.env\.a7|ENV_A7_FILENAME|parseEnvA7/, `${f}: touches A7 env handling`);
    assert.doesNotMatch(src, /Authorization\s*:/, `${f}: sets an Authorization header`);
    assert.doesNotMatch(src, /from\s+["'](\.\/a7-live-transport|@\/lib\/a7-guard|@\/lib\/a7-sentinel-guard)["']/, `${f}: imports A7 transport/guard`);
    assert.doesNotMatch(src, /A7_SUPABASE_MGMT_TOKEN\s*[,)]|env\.A7_SUPABASE_MGMT_TOKEN/, `${f}: reads the A7 token`);
  }
});

test("forbidden refs appear only as the guard's literal constants", () => {
  for (const f of canaryScripts) {
    const src = read(f);
    for (const ref of ["mzqynjywncbvqfikbzgm", "etbuylimyelwoxxowtbx"]) {
      const count = src.split(ref).length - 1;
      if (f === "scripts/canary-guard.ts") assert.equal(count, 1, `${f}: ${ref} defined exactly once`);
      else assert.equal(count, 0, `${f} must not contain ${ref}`);
    }
  }
});

test("only the two transports perform network I/O; plan and libraries are network-free", () => {
  const networkFiles = ["scripts/canary-transport.ts", "scripts/canary-probe-lib.ts"];
  for (const f of canaryScripts) {
    const src = read(f);
    const network = /\bfetch\s*\(|globalThis\.fetch|node:https?|node:net|node:tls/.test(src);
    if (networkFiles.includes(f)) assert.ok(network);
    else assert.ok(!network, `${f}: network code outside the transports`);
  }
  for (const f of ["scripts/canary-plan.ts", "scripts/canary-plan-lib.ts", "scripts/canary-manifest-check.ts"]) {
    assert.doesNotMatch(read(f), /^import (?!type\b)[^;]*from\s+["']\.\/canary-transport["']/m, `${f} must not import the transport`);
  }
});

test("the transport hard-codes read_only:true and has no write path", () => {
  const src = read("scripts/canary-transport.ts");
  assert.match(src, /read_only: true/);
  assert.doesNotMatch(src, /read_only:\s*false/);
  assert.doesNotMatch(src, /execute(Parameterized)?Mutation/);
});

test("the W1/W2 probe lib is the only canary file with read_only:false, allowlist-bound", () => {
  for (const f of canaryScripts) {
    const src = read(f);
    if (f === "scripts/canary-probe-lib.ts") {
      assert.match(src, /read_only: false/);
      assert.match(src, /ALLOWLISTED_PROBE_SQL/, "write requests send only frozen, allowlisted SQL");
      // Exactly one bound-parameter send exists: the P1 sentinel insert (a validated 64-hex digest).
      assert.equal((src.match(/body\.parameters\s*=/g) ?? []).length, 1, "only the P1 insert carries bound parameters");
    } else {
      // Exact code form; canary-plan-lib's header mentions "read_only:false" in prose.
      assert.doesNotMatch(src, /read_only: false/, `${f}: write-capable request outside the probe lib`);
    }
  }
});

test("no canary file lives in supabase/migrations (the closed world stays 68 files)", () => {
  const files = fs.readdirSync(path.join(root, "supabase", "migrations"));
  assert.equal(files.filter((f) => f.endsWith(".sql")).length, 68);
  assert.ok(!files.some((f) => /canary/i.test(f)));
});
