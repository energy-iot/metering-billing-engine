// NavSpinner — single shared inline spinner for pending navigation links.
//
// Contract:
//   - Decorative (`aria-hidden`): the owning link already carries
//     `aria-busy` + the global `NavigationProgress` announces the transition,
//     so this must never double-announce.
//   - Spin is `motion-safe`: `prefers-reduced-motion` users get a static
//     mark, not motion. (The top bar was already gated; the per-link
//     spinners were not — pr-374 design review.)
//   - Token/composition only: `currentColor` stroke, caller-supplied layout
//     classes via `className` (margin + size differ per surface).
//
// Invalidation: if the design system ships a canonical spinner, replace this
// module's body with a re-export.

import { cn } from "@/lib/utils";

export function NavSpinner({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("h-3.5 w-3.5 motion-safe:animate-spin", className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}
