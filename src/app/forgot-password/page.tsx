"use client";

/**
 * /forgot-password — password-reset request page (UX5d / #190).
 *
 * Reached by users clicking "Forgot password?" on /login. Submits an
 * email address; the Supabase server emits a recovery email whose
 * `{{ .ConfirmationURL }}` lands the user on /reset-password with a
 * `?token_hash=…&type=recovery` query string.
 *
 * Email-enumeration defense (AC2 + AC7 of #190):
 *   - Success copy is identical regardless of whether the email exists.
 *     ("If an account exists for {email}, we've sent a password-reset
 *     link.") — phrased as a conditional, never confirms existence.
 *   - Rate-limit error (HTTP 429 / `over_email_send_rate_limit`) shows a
 *     generic banner with no timing detail.
 *   - Generic errors show "Something went wrong. Please try again." —
 *     `error.message` is logged to console but NOT echoed to the UI
 *     (self-hosted Supabase tiers can leak existence via error.message).
 *
 * Per-call redirectTo (AC2 of #190; matches UX5c's per-call pattern):
 *   - `redirectTo: ${window.location.origin}/reset-password` — no global
 *     Site URL change, no server-side `resolveOrigin` helper. The origin
 *     read at call time is correct in the recipient's browser context.
 */
import * as React from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Banner } from "@/components/ui/banner";
import { Input } from "@/components/ui/input";

type Phase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; email: string }
  | { kind: "error"; tone: "rate_limit" | "generic" };

const RATE_LIMIT_MESSAGE =
  "Too many reset attempts. Please wait a few minutes and try again.";
const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

export default function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (phase.kind === "submitting") return;
    if (!email) return;

    setPhase({ kind: "submitting" });
    const supabase = createClient();
    const redirectTo = `${window.location.origin}/reset-password`;
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });

    if (error) {
      // Rate-limit detection: GoTrue surfaces 429 with code
      // `over_email_send_rate_limit` for both invite resends (UX5b)
      // and recovery emails (UX5d).
      const status = (error as { status?: number }).status;
      const code = (error as { code?: string }).code;
      const isRateLimit =
        status === 429 || code === "over_email_send_rate_limit";
      // Diagnostic for operators; never echoed to the UI
      // (enumeration vector on self-hosted tiers).
      console.error("resetPasswordForEmail failed:", error.message);
      setPhase({
        kind: "error",
        tone: isRateLimit ? "rate_limit" : "generic",
      });
      return;
    }

    setPhase({ kind: "success", email });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted px-4">
      <div className="w-full max-w-md rounded-md border border-border bg-card p-8 shadow-sm">
        {phase.kind === "success" ? (
          <div className="space-y-4">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Check your inbox
            </h1>
            <p className="text-sm text-muted-foreground">
              If an account exists for{" "}
              <span className="font-medium text-foreground">{phase.email}</span>
              , we&apos;ve sent a password-reset link. Check your inbox.
            </p>
            <p className="text-sm text-muted-foreground">
              <Link
                href="/login"
                className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
              >
                Back to sign in
              </Link>
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                Forgot your password?
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Enter your email address and we&apos;ll send you a link to
                reset your password.
              </p>
            </div>

            {phase.kind === "error" && (
              <Banner
                tone="destructive"
                title={
                  phase.tone === "rate_limit"
                    ? "Too many attempts"
                    : "Could not send reset email"
                }
              >
                {phase.tone === "rate_limit"
                  ? RATE_LIMIT_MESSAGE
                  : GENERIC_ERROR_MESSAGE}
              </Banner>
            )}

            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div>
                <label
                  htmlFor="forgot-password-email"
                  className="mb-1 block text-xs font-medium text-muted-foreground"
                >
                  Email
                </label>
                <Input
                  id="forgot-password-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={phase.kind === "submitting"}
                  autoComplete="email"
                  required
                  placeholder="you@example.com"
                />
              </div>

              <button
                type="submit"
                disabled={phase.kind === "submitting" || !email}
                className="inline-flex h-9 w-full items-center justify-center rounded-md border border-primary bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {phase.kind === "submitting"
                  ? "Sending…"
                  : "Send reset link"}
              </button>
            </form>

            <p className="text-sm text-muted-foreground">
              <Link
                href="/login"
                className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
              >
                Back to sign in
              </Link>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
