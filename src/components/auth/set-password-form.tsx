"use client";

/**
 * SetPasswordForm — reusable password-collection form (UX5c / #189).
 *
 * Two consumers:
 *   1. /accept-invite — invite-flow new-user onboarding (this ticket).
 *   2. /reset-password — forgot-password recovery (UX5d, future).
 *
 * Stateless re: the Supabase SDK. The form validates password length
 * + confirm match, surfaces inline errors, and propagates the validated
 * password to `onSubmit`. The parent owns `supabase.auth.updateUser({
 * password })` + post-success routing — keeps the component reusable
 * across the two flows without baking in either's side effects.
 *
 * Validation rules (AC3 of #189):
 *   - Minimum 8 characters (UI-enforced regardless of cloud config).
 *   - password === confirm.
 *   - Submit disabled while invalid OR submitting.
 *
 * Inline field errors render below the offending field; submission
 * errors surface as a destructive <Banner> above the form (mirrors
 * EditUserDialog.tsx:264-268).
 */
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Banner } from "@/components/ui/banner";

export interface SetPasswordFormProps {
  /** Heading shown above the form. */
  title: string;
  /** Subtitle/description shown under the title. */
  subtitle: string;
  /** Submit-button label. Defaults to "Set password and sign in". */
  submitLabel?: string;
  /**
   * Called with the validated password. Parent handles the SDK call
   * (e.g. supabase.auth.updateUser) + any post-success routing.
   * Throw / reject to surface a top-level error in the form.
   */
  onSubmit: (password: string) => Promise<void>;
}

const MIN_PASSWORD_LENGTH = 8;

export function SetPasswordForm({
  title,
  subtitle,
  submitLabel = "Set password and sign in",
  onSubmit,
}: SetPasswordFormProps) {
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [topError, setTopError] = React.useState<string | null>(null);
  // Track which fields the user has interacted with so we don't show
  // "must be at least 8 characters" before they've typed anything.
  const [touched, setTouched] = React.useState<{
    password: boolean;
    confirm: boolean;
  }>({ password: false, confirm: false });

  const lengthValid = password.length >= MIN_PASSWORD_LENGTH;
  const matchValid = password === confirm;
  const valid = lengthValid && matchValid && password.length > 0;

  const showLengthError = touched.password && password.length > 0 && !lengthValid;
  const showMatchError =
    touched.confirm && confirm.length > 0 && !matchValid;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTopError(null);
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(password);
      // Parent owns post-success routing. We deliberately don't reset
      // local state — the parent typically navigates away.
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Could not set password. Please try again.";
      setTopError(message);
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {title}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
        {topError && (
          <Banner tone="destructive" title="Could not set password">
            {topError}
          </Banner>
        )}

        <div>
          <label
            htmlFor="set-password-password"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Password
          </label>
          <Input
            id="set-password-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, password: true }))}
            disabled={submitting}
            autoComplete="new-password"
            aria-invalid={showLengthError || undefined}
            aria-describedby={
              showLengthError ? "set-password-password-error" : undefined
            }
            required
          />
          {showLengthError && (
            <p
              id="set-password-password-error"
              className="mt-1 text-xs text-destructive-fg"
            >
              Password must be at least {MIN_PASSWORD_LENGTH} characters.
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="set-password-confirm"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Confirm password
          </label>
          <Input
            id="set-password-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, confirm: true }))}
            disabled={submitting}
            autoComplete="new-password"
            aria-invalid={showMatchError || undefined}
            aria-describedby={
              showMatchError ? "set-password-confirm-error" : undefined
            }
            required
          />
          {showMatchError && (
            <p
              id="set-password-confirm-error"
              className="mt-1 text-xs text-destructive-fg"
            >
              Passwords don&apos;t match.
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={!valid || submitting}
          className="inline-flex h-9 w-full items-center justify-center rounded-md border border-primary bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting ? "Saving…" : submitLabel}
        </button>
      </form>
    </div>
  );
}
