"use client";

/**
 * /reset-password — password-recovery landing page (UX5d / #190).
 *
 * Reached by users clicking the "Reset password" link in the branded
 * recovery email. Supabase email templates expand
 * `{{ .ConfirmationURL }}` to one of two shapes depending on project
 * auth-flow config:
 *
 *  1. **Implicit flow** (URL fragment): `…/reset-password#access_token=…
 *     &refresh_token=…&type=recovery&…`. Full JWT pair in the fragment;
 *     installed client-side via `auth.setSession()`. The fragment is
 *     never sent to the server, so the JWT does not leave the browser
 *     before the SDK persists it.
 *  2. **OTP token-hash flow** (query string): `…/reset-password?
 *     token_hash=…&type=recovery`. Opaque hash exchanged via
 *     `auth.verifyOtp()`.
 *
 * Both flows are handled by `installSessionFromUrl` so this page is
 * robust to future Supabase auth-flow config changes.
 *
 * Mirrors UX5c's /accept-invite structurally (#189) — same shared
 * `installSessionFromUrl` helper, only the `expectedType` literal
 * differs.
 *
 * Flow:
 *   1. `installSessionFromUrl({ supabase, expectedType: "recovery" })`
 *      detects fragment vs query, installs the session via the
 *      appropriate primitive, and confirms `getUser()` returns a user.
 *   2. On success, strip the fragment/query via router.replace so a
 *      refresh doesn't try to re-verify a now-spent token. Then render
 *      `<SetPasswordForm>`.
 *   3. `<SetPasswordForm onSubmit>` calls `supabase.auth.updateUser` —
 *      this page owns the SDK call so the form stays reusable across
 *      both UX5c invite and UX5d reset-password flows.
 *   4. On submit success, router.push("/") + router.refresh() so the
 *      dashboard renders against the freshly-installed session.
 *
 * Error states (#194): The helper differentiates "spent token" (link
 * already used — most common case) from "malformed/never-valid link"
 * and surfaces directed CTAs per kind.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { SetPasswordForm } from "@/components/auth/set-password-form";
import { AuthErrorState } from "@/components/auth/auth-error-state";
import {
  installSessionFromUrl,
  type InstallSessionResult,
} from "@/lib/auth/install-session-from-url";

type ErrorKind = Exclude<InstallSessionResult["kind"], "ok">;

type Phase =
  | { kind: "verifying" }
  | { kind: "ready" }
  | { kind: "error"; errorKind: ErrorKind };

export default function ResetPasswordPage() {
  const router = useRouter();
  const [phase, setPhase] = React.useState<Phase>({ kind: "verifying" });
  // Single-shot guard — React Strict Mode double-mounts effects in
  // development and we MUST NOT call setSession/verifyOtp twice (the
  // second call would race a now-spent token and surface a false
  // error).
  const verifyStartedRef = React.useRef(false);

  React.useEffect(() => {
    if (verifyStartedRef.current) return;
    verifyStartedRef.current = true;

    const supabase = createClient();

    void (async () => {
      const result = await installSessionFromUrl({
        supabase,
        expectedType: "recovery",
      });
      if (result.kind === "ok") {
        // Strip fragment + query from the URL so a refresh doesn't
        // try to re-verify a now-spent token.
        router.replace("/reset-password");
        setPhase({ kind: "ready" });
        return;
      }
      setPhase({ kind: "error", errorKind: result.kind });
    })();
  }, [router]);

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

        {phase.kind === "error" && renderErrorState(phase.errorKind)}

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

function renderErrorState(kind: ErrorKind): React.ReactNode {
  switch (kind) {
    case "spent_token":
      return (
        <AuthErrorState
          title="This reset link has already been used"
          body="If you didn't reset your password yet, request a new link."
          primaryCta={{
            label: "Request a new link →",
            href: "/forgot-password",
          }}
          secondaryCta={{ label: "Back to sign in", href: "/login" }}
        />
      );
    case "type_mismatch":
    case "verify_error":
    case "missing":
      return (
        <AuthErrorState
          title="This password-reset link is invalid or expired"
          body="Request a new one."
          primaryCta={{
            label: "Request a new link →",
            href: "/forgot-password",
          }}
          secondaryCta={{ label: "Back to sign in", href: "/login" }}
        />
      );
  }
}
