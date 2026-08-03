import aws4 from "aws4";

/**
 * Append the JSON-RPC path to a stored backend URL.
 *
 * Trailing slashes are stripped first (#326). An operator who saves
 * `https://host/rest/` would otherwise get `https://host/rest//jsonrpc`, and
 * whether that matters is entirely up to their server: some normalise it, some
 * 404, some route it to a different location block than the one intended. The
 * operator typed something that looks right and cannot see the difference from
 * any screen we show them.
 *
 * Exported so `NoAuth` in ./index.ts uses the same implementation — the bug
 * existed in two places because the append did.
 */
export function appendJsonRpcPath(baseUrl: string): string {
  // Scanned as a loop rather than `replace(/\/+$/, "")` on purpose. That regex
  // is a polynomial ReDoS on operator-supplied input (CodeQL js/polynomial-redos,
  // high) — `+$` backtracks quadratically over a string of many slashes, and
  // this value comes straight from a form field. The loop is linear and cannot
  // backtrack. Do not "simplify" it back into a regex; the gate will reject it,
  // and it would be a real slow-input path in a request handler.
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return `${baseUrl.slice(0, end)}/jsonrpc`;
}

export interface OpenEmsAuth {
  /** Resolve the full request URL given the configured baseUrl. */
  resolveUrl(baseUrl: string): string;
  /**
   * Return signed/authenticated request headers as a plain object.
   * Must return Record<string, string> (not Headers) so test assertions
   * using expect.objectContaining() work correctly.
   */
  apply(request: {
    url: string;
    method: string;
    body: string;
  }): Promise<Record<string, string>>;
}

export class BasicAuth implements OpenEmsAuth {
  constructor(
    private readonly username: string,
    private readonly password: string
  ) {}

  resolveUrl(baseUrl: string): string {
    return appendJsonRpcPath(baseUrl);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async apply(_request: {
    url: string;
    method: string;
    body: string;
  }): Promise<Record<string, string>> {
    return {
      Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`,
      "Content-Type": "application/json",
    };
  }
}

export class SigV4Auth implements OpenEmsAuth {
  constructor(
    private readonly creds: {
      accessKeyId: string;
      secretAccessKey: string;
      region: string;
    }
  ) {}

  resolveUrl(baseUrl: string): string {
    // Lambda handler routes to /jsonrpc internally — sign the root URL
    return baseUrl;
  }

  async apply(req: {
    url: string;
    method: string;
    body: string;
  }): Promise<Record<string, string>> {
    const url = new URL(req.url);

    // NOTE: aws4.sign mutates the options object. Build a fresh one each call.
    const opts = aws4.sign(
      {
        host: url.host,
        path: url.pathname + (url.search || ""),
        method: req.method,
        headers: { "Content-Type": "application/json" },
        body: req.body,
        service: "lambda",
        region: this.creds.region,
      },
      {
        accessKeyId: this.creds.accessKeyId,
        secretAccessKey: this.creds.secretAccessKey,
      }
    );

    // aws4 returns headers as Record<string, string | string[]>; normalize to string values.
    // Pass through ALL headers returned by aws4.sign (Host, X-Amz-Date, Authorization, etc.)
    // so the signature matches what the server verifies.
    const rawHeaders = (opts.headers ?? {}) as Record<
      string,
      string | string[] | undefined
    >;
    return Object.fromEntries(
      Object.entries(rawHeaders)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)])
    );
  }
}
