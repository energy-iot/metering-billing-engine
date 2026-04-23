/**
 * scrub-secrets.ts — redact known-secret values from log messages before they
 * hit stdout/stderr/JSON logs.
 *
 * Why this exists: Postgres can echo the attempted plaintext of a failing
 * constraint back through `error.message` (e.g. "value too long for type X:
 * 'AKIA...'"). Similarly, a stringified request body may land in a caught
 * error's details. If the log pipeline ingests this verbatim, the AWS secret
 * key ends up in Datadog / Vercel logs / Supabase observability — a classic
 * credential leak.
 *
 * Usage:
 *   console.info(JSON.stringify(scrubSecretValues({ event: "openems.discover", err: String(err) }, { secretAccessKey, password })));
 *
 * The second argument is the set of LITERAL secret values to redact. If a
 * value is empty / undefined, it is silently ignored (no regex to compile).
 *
 * Redaction rule: occurrences of any supplied secret string (length >= 6 to
 * avoid false positives on common short tokens) are replaced by `[REDACTED]`.
 * The input object is deep-cloned; the original argument is never mutated.
 */

export type ScrubSecrets = {
  secretAccessKey?: string;
  password?: string;
  /** Opaque additional secrets (e.g. a discovered API token). */
  extra?: string[];
};

// Minimum length of a secret fragment we'll scrub. Prevents false positives
// on short common tokens (e.g. "admin", "test"). Real AWS secret keys are
// 40 chars; passwords in this codebase are >=8.
const MIN_SECRET_LENGTH = 6;

function collectSecrets(secrets: ScrubSecrets): string[] {
  const out: string[] = [];
  const push = (s: string | undefined) => {
    if (s && s.length >= MIN_SECRET_LENGTH) out.push(s);
  };
  push(secrets.secretAccessKey);
  push(secrets.password);
  if (secrets.extra) {
    for (const e of secrets.extra) push(e);
  }
  return out;
}

function escapeRegExp(s: string): string {
  // Escape every regex metachar so we can match a literal secret body.
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceInString(input: string, secrets: string[]): string {
  let result = input;
  for (const secret of secrets) {
    // Global match so every occurrence is redacted, not just the first.
    result = result.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }
  return result;
}

/**
 * Walk an arbitrary JSON-ish value and replace literal secret occurrences
 * inside every string leaf with `[REDACTED]`. Arrays and plain objects are
 * descended; everything else (numbers, booleans, null, undefined) passes
 * through.
 */
export function scrubSecretValues<T>(value: T, secrets: ScrubSecrets): T {
  const secretList = collectSecrets(secrets);
  if (secretList.length === 0) return value;
  return scrubRecursive(value, secretList) as T;
}

function scrubRecursive(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    return replaceInString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubRecursive(v, secrets));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubRecursive(v, secrets);
    }
    return out;
  }
  return value;
}
