// EmptyState — reusable empty-state primitive for list/section surfaces (#139).
//
// The "gold standard" we're rhyming with:
//   - microgrids/[id]/setup/openems-backend/openems-backend-shell.tsx  (lines 465–507)
//   - communities/[id]/payment/payment-shell.tsx                       (lines 256–286)
//
// Shared shape (pinned by designer per #137):
//   max-w-[560px] · mx-auto · rounded-md · border border-border · bg-card ·
//   p-6 · shadow-elev-1
//
// Typography mirrors the shell empties:
//   - Eyebrow:  text-[10px] font-semibold uppercase tracking-wide text-muted-foreground
//   - Title:    text-lg font-semibold text-foreground
//   - Body:     text-sm text-muted-foreground  (mt-2)
//   - CTA row:  mt-4
//   - Footnote: text-xs text-muted-foreground  (mt-4)
//
// Escape hatches (stay bespoke; DO NOT convert to this primitive):
//   - openems-backend empty-state: needs the segmented "Cloud (AWS) / Direct URL"
//     toggle. Unique shape.
//   - payment empty-state: single provider Connect Pesapal button + provider
//     roadmap footnote. Close enough; PM chose to leave it.
//
// Role-aware:
//   When `cta` is null/undefined, callers can pass a `footnote` string instead
//   (e.g. "Ask a super admin to add edges."). This mirrors the openems-backend
//   non-super-admin branch that renders a <Banner tone="info"> instead of a form.
//   Callers wanting that banner shape should keep using <Banner>; this primitive
//   is the card shape.
//
// A11y:
//   - role="region" + aria-labelledby linking to the title — this is a
//     discrete landmark for keyboard users navigating sections.
//   - Title renders as <h3>. Callers place this under a section <h2>.
//   - If the parent surface just transitioned from populated → empty (e.g. user
//     deleted the last tier), the parent should announce via a separate
//     aria-live region; this component is static once mounted.

import * as React from "react";
import { cn } from "@/lib/utils";

export type EmptyStateTone = "neutral" | "warn";

export interface EmptyStateProps {
  /** Short category above the title — e.g. "Communities", "Rate schedule".
   *  Should match the surrounding section's <h2>. */
  eyebrow?: string;
  /** Imperative title — "Add the first community", not "No communities". */
  title: string;
  /** One or two sentences explaining what this entity IS (operator-voice). */
  body: React.ReactNode;
  /** Primary CTA — typically <AddEntityButton> or <Link>-styled button.
   *  Omit for role-locked views; pass `footnote` instead. */
  cta?: React.ReactNode;
  /** Secondary action — typically a <Link> to documentation or a sibling page. */
  secondary?: React.ReactNode;
  /** Small italic/muted footnote rendered below the CTA row.
   *  Use for caveats ("You can change this later") or role-locked help-text. */
  footnote?: React.ReactNode;
  /** neutral (default) = card shape. warn = inject a left border-warning accent,
   *  used when something upstream is blocking (e.g. "Edge offline, can't
   *  discover yet"). */
  tone?: EmptyStateTone;
  /** Optional decorative icon slot (left of title). aria-hidden enforced.
   *  Keep simple — lucide-react 20px glyph. No illustrations (PM §5). */
  icon?: React.ReactNode;
  className?: string;
  /** HTML id for the card — useful for deep-linking and aria-describedby. */
  id?: string;
}

export function EmptyState({
  eyebrow,
  title,
  body,
  cta,
  secondary,
  footnote,
  tone = "neutral",
  icon,
  className,
  id,
}: EmptyStateProps) {
  const reactId = React.useId();
  const titleId = `${id ?? reactId}-title`;

  return (
    <div
      id={id}
      role="region"
      aria-labelledby={titleId}
      className={cn(
        "mx-auto max-w-[560px] rounded-md border bg-card p-6 shadow-elev-1",
        tone === "warn" ? "border-warning border-l-4" : "border-border",
        className,
      )}
    >
      {eyebrow && (
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {eyebrow}
        </p>
      )}

      <div className="mt-1 flex items-start gap-3">
        {icon && (
          <span aria-hidden="true" className="mt-0.5 text-muted-foreground">
            {icon}
          </span>
        )}
        <h3 id={titleId} className="text-lg font-semibold text-foreground">
          {title}
        </h3>
      </div>

      <div className="mt-2 text-sm text-muted-foreground">{body}</div>

      {(cta || secondary) && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {cta}
          {secondary}
        </div>
      )}

      {footnote && (
        <p className="mt-4 text-xs text-muted-foreground">{footnote}</p>
      )}
    </div>
  );
}
