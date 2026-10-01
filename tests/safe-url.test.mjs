// SSRF boundary for website knowledge import. No external network: DNS and the
// transport are injected; one test uses a real server on 127.0.0.1 to prove a
// blocked target never receives a request.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { isPublicIp, checkUrlShape, assertSafeUrl, makeSafeLookup, UnsafeUrlError } = await import("@/lib/safe-url");
const { safeFetchText } = await import("@/lib/safe-fetch");

const dnsTable = {
  "www.example.com": ["93.184.215.14"],
  "clinic.example.org": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
  "evil-private.example.com": ["10.0.0.5"],
  "evil-mixed.example.com": ["93.184.215.14", "192.168.1.10"],
  "evil-metadata.example.com": ["169.254.169.254"],
  "evil-v6.example.com": ["fd00::1"],
  "evil-mapped.example.com": ["::ffff:127.0.0.1"],
};
const resolve = async (h) => {
  if (!(h in dnsTable)) throw new Error("ENOTFOUND");
  return dnsTable[h];
};
const blocked = async (url) => {
  await assert.rejects(assertSafeUrl(url, resolve), (e) => e instanceof UnsafeUrlError, url);
};

test("public addresses are allowed; private / internal / special ranges are not", () => {
  for (const ip of ["93.184.215.14", "8.8.8.8", "1.1.1.1", "2606:4700::1111", "2a00:1450:4001:80b::200e"]) assert.equal(isPublicIp(ip), true, ip);
  for (const ip of [
    "127.0.0.1", "127.255.255.254", "0.0.0.0", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1",
    "169.254.169.254", "169.254.0.1", "100.64.0.1", "224.0.0.1", "255.255.255.255", "192.0.2.1", "198.18.0.1",
    "::1", "::", "fd00::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
    "::ffff:10.0.0.1", "64:ff9b::a00:1", "::127.0.0.1", "not-an-ip", "",
  ]) assert.equal(isPublicIp(ip), false, ip);
  // 172.15 and 172.32 are public (just outside RFC1918 172.16/12).
  assert.equal(isPublicIp("172.15.255.255"), true);
  assert.equal(isPublicIp("172.32.0.1"), true);
});

test("blocked URL forms: localhost, loopback, RFC1918, link-local, metadata, IPv6 internal", async () => {
  for (const url of [
    "http://localhost/", "http://LOCALHOST./", "http://app.localhost/", "http://127.0.0.1/", "http://127.1/", "http://2130706433/",
    "http://0x7f.0.0.1/", "http://0177.0.0.1/", "http://10.1.2.3/", "http://172.16.5.4/", "http://172.31.0.1/", "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/", "http://metadata.google.internal/", "http://instance-data/", "http://[::1]/",
    "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/", "http://router/", "http://printer.local/",
    "http://db.internal/",
  ]) await blocked(url);
});

test("non-http(s), credentials, odd ports and garbage are refused", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "http://user:pass@www.example.com/", "http://www.example.com:8080/", "http://www.example.com:22/", "not a url", ""]) {
    await blocked(url);
  }
  assert.equal(checkUrlShape("https://www.example.com:443/x").hostname, "www.example.com");
});

test("a hostname that RESOLVES to a private / metadata / mixed address is blocked", async () => {
  for (const host of ["evil-private.example.com", "evil-mixed.example.com", "evil-metadata.example.com", "evil-v6.example.com", "evil-mapped.example.com", "unresolvable.example.com"]) {
    await blocked(`https://${host}/`);
  }
});

test("valid public https URLs are allowed", async () => {
  for (const url of ["https://www.example.com/", "https://clinic.example.org/our-team", "http://www.example.com/", "https://93.184.215.14/", "https://[2606:4700::1111]/"]) {
    const u = await assertSafeUrl(url, resolve);
    assert.ok(u instanceof URL, url);
  }
});

function transport(routes) {
  const calls = [];
  return {
    calls,
    requestOnce: async (url) => {
      calls.push(url.href);
      const r = routes[url.href];
      if (!r) return { status: 404, location: null, body: "" };
      return { status: r.status ?? 200, location: r.location ?? null, body: r.body ?? "" };
    },
  };
}

test("a redirect to a private / metadata target is refused BEFORE it is requested", async () => {
  for (const target of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1/admin", "https://evil-private.example.com/", "http://[::1]/"]) {
    const t = transport({ "https://www.example.com/": { status: 302, location: target } });
    await assert.rejects(safeFetchText("https://www.example.com/", {}, { resolve, requestOnce: t.requestOnce }), (e) => e instanceof UnsafeUrlError, target);
    assert.deepEqual(t.calls, ["https://www.example.com/"], "the internal target was never requested");
  }
});

test("safe redirects are followed (relative and absolute), with a hop limit", async () => {
  const t = transport({
    "https://www.example.com/": { status: 301, location: "/home" },
    "https://www.example.com/home": { status: 302, location: "https://clinic.example.org/" },
    "https://clinic.example.org/": { status: 200, body: "<title>Clinic</title>" },
  });
  const r = await safeFetchText("https://www.example.com/", {}, { resolve, requestOnce: t.requestOnce });
  assert.equal(r.ok, true);
  assert.equal(r.text, "<title>Clinic</title>");
  assert.equal(r.finalUrl, "https://clinic.example.org/");
  const loop = transport({ "https://www.example.com/": { status: 302, location: "https://www.example.com/" } });
  await assert.rejects(safeFetchText("https://www.example.com/", { maxRedirects: 3 }, { resolve, requestOnce: loop.requestOnce }), /too many times/);
});

test("connect-time DNS check (rebinding): the socket lookup refuses private answers", async () => {
  const lookupFor = (answers) => makeSafeLookup(async () => answers);
  const run = (fn, opts) => new Promise((res) => fn("rebind.example.com", opts, (err, address) => res({ err, address })));
  const bad = await run(lookupFor([{ address: "10.0.0.7", family: 4 }]), {});
  assert.equal(bad.err?.code, "EUNSAFEADDR");
  const mixed = await run(lookupFor([{ address: "93.184.215.14", family: 4 }, { address: "127.0.0.1", family: 4 }]), { all: true });
  assert.equal(mixed.err?.code, "EUNSAFEADDR");
  const good = await run(lookupFor([{ address: "93.184.215.14", family: 4 }]), {});
  assert.equal(good.err, null);
  assert.equal(good.address, "93.184.215.14");
});

test("end-to-end: a real server on 127.0.0.1 never receives the request", async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.end("internal secret"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    await assert.rejects(safeFetchText(`http://127.0.0.1:${port}/`), (e) => e instanceof UnsafeUrlError);
    await assert.rejects(safeFetchText("http://127.0.0.1/"), (e) => e instanceof UnsafeUrlError);
    assert.equal(hits, 0);
  } finally {
    server.close();
  }
});
