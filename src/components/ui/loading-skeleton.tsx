// LoadingSkeleton — shared placeholder block for route loading.tsx files.
//
// Contract:
//   - Server component (no hooks): safe to import from loading.tsx and from
//     client components alike.
//   - Token classes only (`bg-muted`); shimmer sweep is `motion-safe` so
//     `prefers-reduced-motion` users get a static block, not motion.
//   - Decorative: callers own the accessible announcement (the loading.tsx
//     root carries `role="status"` + sr-only text), so blocks are
//     `aria-hidden` here and never double-announce.
//
// Visual matches the existing PeriodPicker skeleton (bg-muted + shimmer) so
// ad-hoc and route-level placeholders read as one pattern.
//
// Invalidation: if the design system ever ships a canonical <Skeleton>,
// replace this module's body with a re-export and delete the local styles.

import { cn } from "@/lib/utils";

export function LoadingSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("relative overflow-hidden rounded-sm bg-muted", className)}>
      <span
        aria-hidden="true"
        className="absolute inset-0 motion-safe:[animation:mbe-shimmer_1.4s_ease-in-out_infinite]"
        style={{
          backgroundImage:
            "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)",
        }}
      />
    </div>
  );
}
