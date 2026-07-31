/**
 * Validation for the operator-supplied OpenEMS backend URL
 * (`microgrids.ems_backend_url`).
 *
 * The value is persisted from `PUT /api/microgrids/[id]/openems-backend` and
 * the server then POSTs a JSON-RPC payload to it. Before this module the only
 * gate was "non-empty string", so any scheme and any host was accepted.
 *
 * Rules (mbe-docs#8):
 *   1. Must parse as an absolute URL.
 *   2. Scheme must be `https:`. `http:` is allowed only for `localhost`,
 *      which `src/lib/openems/index.ts` documents as a supported development
 *      case for `direct_url` mode.
 *   3. No embedded credentials (`user:pass@host`).
 *   4. Literal private, loopback and link-local addresses are rejected.
 *   5. No fragment / query — the client appends `/jsonrpc` to this base URL,
 *      so anything after the path would be silently dropped or reordered.
 *
 * Names are not resolved here. This validates the value the operator typed;
 * DNS re-resolution at request time is separate hardening and out of scope.
 * The companion half of the fix lives in `client.ts`, which no longer follows
 * redirects — without it a host that passes these checks can still hand the
 * request to a different one at call time.
 */

export type BackendUrlValidation =
  | { ok: true; url: string }
  | { ok: false; error: string };

/** Hosts allowed to use `http:` and exempt from the private-range block. */
function isLocalhostName(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost");
}

/**
 * Parse a dotted-decimal IPv4 literal into its four octets.
 *
 * The WHATWG URL parser already normalises alternative IPv4 spellings
 * (hex `0x7f.0.0.1`, octal, 32-bit decimal `2130706433`) into dotted-decimal
 * in `url.hostname`, so matching the canonical form here is sufficient.
 */
function parseIPv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** Expand an IPv6 literal (already stripped of `[]`) into 16 bytes. */
function parseIPv6(hostname: string): number[] | null {
  let host = hostname;
  // Drop a zone index (`fe80::1%eth0`) before parsing.
  const pct = host.indexOf("%");
  if (pct !== -1) host = host.slice(0, pct);
  if (!host.includes(":")) return null;

  // A trailing IPv4 form (`::ffff:127.0.0.1`) becomes two 16-bit groups.
  let tail: number[] = [];
  const lastColon = host.lastIndexOf(":");
  const lastPart = host.slice(lastColon + 1);
  if (lastPart.includes(".")) {
    const v4 = parseIPv4(lastPart);
    if (!v4) return null;
    tail = v4;
    host = host.slice(0, lastColon + 1) + "0:0";
  }

  const doubleColon = host.indexOf("::");
  let groups: string[];
  if (doubleColon !== -1) {
    if (host.indexOf("::", doubleColon + 1) !== -1) return null;
    const head = host.slice(0, doubleColon);
    const rest = host.slice(doubleColon + 2);
    const headGroups = head === "" ? [] : head.split(":");
    const restGroups = rest === "" ? [] : rest.split(":");
    const missing = 8 - (headGroups.length + restGroups.length);
    if (missing < 0) return null;
    groups = [...headGroups, ...Array(missing).fill("0"), ...restGroups];
  } else {
    groups = host.split(":");
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }

  // Overwrite the last four bytes when the literal carried an IPv4 tail.
  if (tail.length === 4) {
    bytes[12] = tail[0];
    bytes[13] = tail[1];
    bytes[14] = tail[2];
    bytes[15] = tail[3];
  }
  return bytes;
}

/**
 * Classify a literal IP as a destination we refuse to store, returning a
 * human label for the error message, or null when the address is routable.
 */
function blockedIpReason(hostname: string): string | null {
  const v4 = parseIPv4(hostname);
  if (v4) return blockedIPv4Reason(v4);

  const stripped =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const v6 = parseIPv6(stripped);
  if (!v6) return null;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — judge on the IPv4 part.
  const firstTwelveZero = v6.slice(0, 10).every((b) => b === 0);
  if (firstTwelveZero && v6[10] === 0xff && v6[11] === 0xff) {
    return blockedIPv4Reason(v6.slice(12));
  }

  // ::1 — IPv6 loopback.
  if (v6.slice(0, 15).every((b) => b === 0) && v6[15] === 1) {
    return "a loopback address";
  }
  // ::  — unspecified.
  if (v6.every((b) => b === 0)) return "an unspecified address";
  // fc00::/7 — unique-local.
  if ((v6[0] & 0xfe) === 0xfc) return "a unique-local address";
  // fe80::/10 — link-local.
  if (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80) return "a link-local address";

  return null;
}

function blockedIPv4Reason(o: number[]): string | null {
  if (o[0] === 127) return "a loopback address";
  if (o[0] === 0) return "an unspecified address";
  if (o[0] === 10) return "a private address";
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return "a private address";
  if (o[0] === 192 && o[1] === 168) return "a private address";
  if (o[0] === 169 && o[1] === 254) return "a link-local address";
  return null;
}

const EXAMPLE = "for example https://openems.example.com";

/**
 * Validate an operator-supplied OpenEMS backend URL.
 *
 * On success returns the trimmed value (unchanged otherwise — we persist what
 * the operator typed so the config screen shows the URL actually contacted).
 */
export function validateBackendUrl(raw: string): BackendUrlValidation {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: `backendUrl is required — ${EXAMPLE}.` };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: `backendUrl must be an absolute URL including the scheme — ${EXAMPLE}.`,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error:
        "backendUrl must not contain embedded credentials (user:password@host). Remove them from the URL — OpenEMS credentials belong in the Cloud (AWS) fields, not the URL.",
    };
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return {
      ok: false,
      error: `backendUrl must include a host — ${EXAMPLE}.`,
    };
  }

  const localhost = isLocalhostName(hostname);

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      error: `backendUrl must use https:// — got "${parsed.protocol.replace(/:$/, "")}://". ${EXAMPLE}.`,
    };
  }

  if (parsed.protocol === "http:" && !localhost) {
    return {
      ok: false,
      error:
        `backendUrl must use https:// — http:// is accepted only for localhost during development. ` +
        `If the backend already serves TLS, store the https:// URL (${EXAMPLE}).`,
    };
  }

  if (!localhost) {
    const reason = blockedIpReason(hostname);
    if (reason) {
      return {
        ok: false,
        error:
          `backendUrl points at ${reason} (${hostname}), which this server will not call. ` +
          `Use the backend's publicly reachable https:// hostname — it must be reachable from Vercel, ${EXAMPLE}.`,
      };
    }
  }

  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      error:
        "backendUrl must not contain a query string or fragment — store the base URL only; the JSON-RPC path is appended automatically.",
    };
  }

  return { ok: true, url: trimmed };
}
