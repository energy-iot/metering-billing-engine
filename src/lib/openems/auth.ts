import aws4 from "aws4";

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
    return `${baseUrl}/jsonrpc`;
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
