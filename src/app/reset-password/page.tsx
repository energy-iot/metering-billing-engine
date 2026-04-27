"use client";

/**
 * /reset-password — password-recovery landing page (UX5d / #190).
 *
 * Reached by users clicking the "Reset password" link in the branded
 * recovery email. Supabase expands `{{ .ConfirmationURL }}` to
 * `${redirectTo}?token_hash=<hash>&type=recovery&redirect_to=…` for
 * this project's auth flow.
 *
 * Mirrors UX5c's /accept-invite structurally (#189) — same `verifyOtp`
 * primitive, only the `type` literal differs.
 *
 * Flow:
 *   1. Read `token_hash` + `type` from the URL query string.
 *      - Validate `type === "recovery"`. Surface error state on mismatch
 *        or `?error=…`/`?error_description=…` from GoTrue.
 *   2. Call `supabase.auth.verifyOtp({ token_hash, type: "recovery" })`.
 *      - Wrong primitive for server-issued recovery emails is
 *        `exchangeCodeForSession` (PKCE) — that requires a code-verifier
 *        cookie set by the ORIGINATING browser; recipient who clicked
 *        the email link has no such cookie, so PKCE throws
 *        AuthPKCECodeVerifierMissingError. UX5c R2 verified this.
 *      - `verifyOtp` is stateless on the client, which means a user
 *        can forward a reset link from one machine to another and the
 *        recipient still completes the flow (cross-browser positive
 *        behaviour).
 *   3. After verifyOtp succeeds, the SDK installs session cookies
 *      automatically. Strip token_hash + type from the URL via
 *      router.replace so a refresh doesn't try to re-verify a now-
 *      spent token.
 *   4. Defensively confirm getUser() returns a user before rendering
 *      the form.
 *   5. <SetPasswordForm onSubmit> calls supabase.auth.updateUser —
 *      this page owns the SDK call so the form stays reusable across
 *      both invite and recovery flows.
 *   6. On success, router.push("/") + router.refresh() so the
 *      dashboard renders against the freshly-installed session.
 */
import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { SetPasswordForm } from "@/components/auth/set-password-form";
import { Banner } from "@/components/ui/banner";

type Phase =
  | { kind: "verifying" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

const ERROR_INVALID_LINK =
  "This password-reset link is invalid or expired. Request a new one.";
const ERROR_EXPIRED_OR_USED =
  "This password-reset link has expired or has already been used. Request a new one.";

export default function ResetPasswordPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [phase, setPhase] = React.useState<Phase>({ kind: "verifying" });
  // Single-shot guard — React Strict Mode double-mounts effects in
  // development and we MUST NOT call verifyOtp twice (the second call
  // would race the now-spent token_hash and surface a false error).
  const verifyStartedRef = React.useRef(false);

  React.useEffect(() => {
    if (verifyStartedRef.current) return;
    verifyStartedRef.current = true;

    const tokenHash = searchParams.get("token_hash");
    const type = searchParams.get("type");
    const errorDescription =
      searchParams.get("error_description") || searchParams.get("error");

    if (errorDescription) {
      setPhase({ kind: "error", message: ERROR_INVALID_LINK });
      return;
    }

    if (!tokenHash || type !== "recovery") {
      setPhase({ kind: "error", message: ERROR_INVALID_LINK });
      return;
    }

    const supabase = createClient();

    void (async () => {
      const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: "recovery",
      });
      if (error) {
        setPhase({ kind: "error", message: ERROR_EXPIRED_OR_USED });
        return;
      }
      // Defensive: confirm a session was installed. verifyOtp returns
      // success but the session may be absent if cookies failed to
      // persist — surface the standard error in that edge case.
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) {
        setPhase({ kind: "error", message: ERROR_EXPIRED_OR_USED });
        return;
      }
      // Strip the token_hash + type from the URL so a refresh doesn't
      // try to re-verify a now-spent token.
      router.replace("/reset-password");
      setPhase({ kind: "ready" });
    })();
  }, [router, searchParams]);

  async function handleSetPassword(password: string): Promise<void> {
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      // SetPasswordForm surfaces the thrown message in its top-level
      // <Banner tone="destructive">.
      throw new Error(error.message || "Could not set password.");
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted px-4">
      <div className="w-full max-w-md rounded-md border border-border bg-card p-8 shadow-sm">
        {phase.kind === "verifying" && (
          <div className="text-center" role="status" aria-live="polite">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Verifying your reset link…
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              One moment while we confirm your password-reset link.
            </p>
          </div>
        )}

        {phase.kind === "error" && (
          <div className="space-y-4">
            <Banner tone="destructive" title="Reset link problem">
              {phase.message}
            </Banner>
            <p className="text-sm text-muted-foreground">
              <Link
                href="/forgot-password"
                className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
              >
                Back to forgot password
              </Link>
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
        )}

        {phase.kind === "ready" && (
          <SetPasswordForm
            title="Reset your password"
            subtitle="Choose a new password for your account."
            submitLabel="Update password and sign in"
            onSubmit={handleSetPassword}
          />
        )}
      </div>
    </div>
  );
}
