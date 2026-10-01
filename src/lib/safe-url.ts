import net from "node:net";
import dns from "node:dns";

// SSRF boundary for every server-side fetch of a user-supplied URL (website
// knowledge import). A URL is only fetched when:
//   • it is http(s), on the default port (80/443), with no embedded credentials;
//   • its hostname is not an internal name (localhost, *.local, *.internal, a
//     single-label name, cloud metadata names);
//   • it is an IP literal in PUBLIC unicast space, or a name whose EVERY DNS
//     answer is public — the check is on resolved addresses, not on strings;
// and at connect time (safeLookup) the address actually used is re-checked, so
// a DNS answer that changes between the check and the connection (rebinding)
// is still refused. Redirects are followed manually and each hop re-validated
// (see safe-fetch.ts).

export class UnsafeUrlError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "UnsafeUrlError";
  }
}

const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],        // "this network"
  ["10.0.0.0", 8],       // RFC1918
  ["100.64.0.0", 10],    // carrier-grade NAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local (incl. 169.254.169.254 cloud metadata)
  ["172.16.0.0", 12],    // RFC1918
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.0.2.0", 24],     // TEST-NET-1
  ["192.88.99.0", 24],   // 6to4 relay anycast
  ["192.168.0.0", 16],   // RFC1918
  ["198.18.0.0", 15],    // benchmarking
  ["198.51.100.0", 24],  // TEST-NET-2
  ["203.0.113.0", 24],   // TEST-NET-3
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved + broadcast
] as const) BLOCKED.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [
  ["::", 96],            // unspecified, loopback (::1) and IPv4-compatible
  ["64:ff9b:1::", 48],   // local-use NAT64
  ["100::", 64],         // discard
  ["2001::", 23],        // IETF protocol assignments (incl. Teredo 2001::/32)
  ["2001:db8::", 32],    // documentation
  ["2002::", 16],        // 6to4 (embeds an arbitrary IPv4)
  ["fc00::", 7],         // unique local (private)
  ["fe80::", 10],        // link-local
  ["fec0::", 10],        // deprecated site-local
  ["ff00::", 8],         // multicast
] as const) BLOCKED.addSubnet(addr, prefix, "ipv6");

/** Expand an IPv6 address into 8 numeric groups (null if malformed). */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  // Trailing dotted IPv4 (::ffff:1.2.3.4) → two hex groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    if (net.isIPv4(v4[1]) === false) return null;
    const o = v4[1].split(".").map(Number);
    s = s.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True only for globally routable unicast addresses. Anything unparseable is NOT public. */
export function isPublicIp(ip: string): boolean {
  const addr = String(ip ?? "").trim().replace(/^\[|\]$/g, "");
  if (net.isIPv4(addr)) return !BLOCKED.check(addr, "ipv4");
  if (!net.isIPv6(addr.split("%")[0])) return false;
  const g = ipv6Groups(addr);
  if (!g) return false;
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) embed an IPv4 — judge that.
  const embedded = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicIp(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicIp(embedded);
  return !BLOCKED.check(g.map((x) => x.toString(16)).join(":"), "ipv6");
}

const INTERNAL_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/i;
const METADATA_HOSTS = new Set(["metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal"]);

/** Synchronous checks on the URL itself (no DNS). Returns the parsed URL or throws UnsafeUrlError. */
export function checkUrlShape(raw: string): URL {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new UnsafeUrlError("invalid_url", "That doesn't look like a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UnsafeUrlError("bad_protocol", "Only http and https URLs can be imported.");
  if (u.username || u.password) throw new UnsafeUrlError("credentials", "URLs with embedded credentials can't be imported.");
  if (u.port && u.port !== "80" && u.port !== "443") throw new UnsafeUrlError("bad_port", "Only websites on the standard ports (80/443) can be imported.");
  // WHATWG URL already canonicalises numeric IPv4 forms (2130706433, 0x7f.1) to dotted quads.
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const literal = host.replace(/^\[|\]$/g, "");
  if (net.isIP(literal)) {
    if (!isPublicIp(literal)) throw new UnsafeUrlError("private_address", "That address is on a private or internal network and can't be imported.");
    return u;
  }
  if (!host || !host.includes(".") || INTERNAL_SUFFIX.test(host) || METADATA_HOSTS.has(host)) {
    throw new UnsafeUrlError("internal_host", "That address is on a private or internal network and can't be imported.");
  }
  return u;
}

export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) => {
  const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
};

/** Full validation: URL shape + every resolved address public. Throws UnsafeUrlError. */
export async function assertSafeUrl(raw: string, resolve: Resolver = systemResolver): Promise<URL> {
  const u = checkUrlShape(raw);
  const literal = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literal)) return u;
  let addrs: string[];
  try {
    addrs = await resolve(u.hostname);
  } catch {
    throw new UnsafeUrlError("dns_failed", "Could not resolve that website's address.");
  }
  if (!addrs.length) throw new UnsafeUrlError("dns_failed", "Could not resolve that website's address.");
  if (addrs.some((a) => !isPublicIp(a))) {
    throw new UnsafeUrlError("private_address", "That website resolves to a private or internal network address and can't be imported.");
  }
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

/**
 * Drop-in `lookup` for http/https.request: resolves, and refuses the
 * connection if ANY answer is non-public — enforced at connect time, so DNS
 * rebinding between assertSafeUrl and the request cannot reach an internal host.
 */
export function makeSafeLookup(lookupAll: (host: string) => Promise<dns.LookupAddress[]> = (h) => dns.promises.lookup(h, { all: true, verbatim: true })) {
  return (hostname: string, options: dns.LookupOptions | number | undefined, cb: LookupCb) => {
    const wantAll = typeof options === "object" && options !== null && !!options.all;
    lookupAll(hostname).then(
      (addrs) => {
        if (!addrs.length || addrs.some((a) => !isPublicIp(a.address))) {
          const e = new UnsafeUrlError("private_address", "Blocked connection to a private or internal network address.") as unknown as NodeJS.ErrnoException;
          e.code = "EUNSAFEADDR";
          return cb(e);
        }
        if (wantAll) return cb(null, addrs);
        cb(null, addrs[0].address, addrs[0].family);
      },
      (err) => cb(err)
    );
  };
}
