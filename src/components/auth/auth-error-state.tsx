"use client";

/**
 * AuthErrorState — shared error-state surface for auth landing pages
 * (UX5c /accept-invite, UX5d /reset-password). Added in #194.
 *
 * Wraps `<Banner tone="destructive">` with optional primary + secondary
 * CTA links, matching the auth pages' `max-w-md` card shape. Not built
 * on `<EmptyState>` — that primitive is `max-w-[560px]` and shaped for
 * dashboard list surfaces, a different visual context.
 *
 * Token-class-only per Design System rule #3 (`CLAUDE.md`). The primary
 * button mirrors `<SetPasswordForm>`'s submit button (set-password-form.tsx:166-171)
 * for visual continuity across the page; the secondary link mirrors the
 * existing `text-sm text-muted-foreground` + underlined inner span from
 * the previous accept-invite/reset-password inline error.
 */
import * as React from "react";
import Link from "next/link";
import { Banner } from "@/components/ui/banner";

export interface AuthErrorStateProps {
  /** Heading rendered as the Banner title. */
  title: string;
  /** Body content under the title; rendered inside the Banner. */
  body: React.ReactNode;
  /**
   * Primary call-to-action — rendered as a full-width primary button-link
   * below the banner. Use for the most likely next step (e.g. "Sign in →"
   * for a spent invite, "Request a new link →" for a spent reset).
   */
  primaryCta?: { label: string; href: string };
  /**
   * Secondary call-to-action — rendered as a muted underlined text link
   * below the primary CTA (or below the banner if no primary). Use for
   * the fallback path (e.g. "Back to sign in" for a generic error).
   */
  secondaryCta?: { label: string; href: string };
}

export function AuthErrorState({
  title,
  body,
  primaryCta,
  secondaryCta,
}: AuthErrorStateProps) {
  return (
    <div className="space-y-4">
      <Banner tone="destructive" title={title}>
        {body}
      </Banner>

      {primaryCta && (
        <Link
          href={primaryCta.href}
          className="inline-flex h-9 w-full items-center justify-center rounded-md border border-primary bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {primaryCta.label}
        </Link>
      )}

      {secondaryCta && (
        <p className="text-sm text-muted-foreground">
          <Link
            href={secondaryCta.href}
            className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
          >
            {secondaryCta.label}
          </Link>
        </p>
      )}
    </div>
  );
}
