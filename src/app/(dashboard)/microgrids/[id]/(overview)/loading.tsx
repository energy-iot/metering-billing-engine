// Microgrid overview loading fallback.
//
// Lives in the `(overview)` route group so it scopes to the overview page
// ONLY — not the whole `[id]` subtree (setup/*, tenants, billing list each
// get the generic `[id]/loading.tsx` frame instead; pr-375 review). Route
// groups are URL-transparent, so the page URL is unchanged.
//
// Shown while the overview page (5+ Supabase queries + OpenEMS status/energy
// calls) resolves. Mirrors the page's own layout with token-only skeleton
// blocks so the frame doesn't jump when content lands.
//
// Accessibility: single role="status" announcer on the root; all blocks are
// decorative (aria-hidden inside LoadingSkeleton).

import { LoadingSkeleton } from "@/components/ui/loading-skeleton";

export default function MicrogridOverviewLoading() {
  return (
    <div role="status" aria-label="Loading microgrid overview" aria-busy="true" className="space-y-4">
      <span className="sr-only">Loading microgrid overview…</span>

      {/* Breadcrumb + actions row */}
      <div className="flex items-center justify-between">
        <div className="mb-2 flex gap-1">
          <LoadingSkeleton className="h-9 w-36" />
          <LoadingSkeleton className="h-9 w-28" />
          <LoadingSkeleton className="h-9 w-32" />
        </div>
        <LoadingSkeleton className="h-8 w-24" />
      </div>

      {/* Edge health card */}
      <section aria-hidden="true" className="rounded-lg border border-border bg-card px-4 py-3">
        <LoadingSkeleton className="mb-2 h-3 w-16" />
        <div className="flex gap-2">
          <LoadingSkeleton className="h-6 w-28" />
          <LoadingSkeleton className="h-6 w-28" />
          <LoadingSkeleton className="h-6 w-28" />
        </div>
      </section>

      {/* Open-period summary strip (5 cells) */}
      <section aria-hidden="true" className="rounded-lg border border-border bg-card px-4 py-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <LoadingSkeleton className="h-3 w-3/4" />
              <LoadingSkeleton className="h-5 w-full" />
            </div>
          ))}
        </div>
      </section>

      {/* Leaderboard + calendar */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section aria-hidden="true" className="rounded-lg border border-border bg-card px-4 py-3">
          <LoadingSkeleton className="mb-2 h-3 w-32" />
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <LoadingSkeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </section>
        <section aria-hidden="true" className="rounded-lg border border-border bg-card px-4 py-3">
          <LoadingSkeleton className="mb-2 h-3 w-40" />
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 30 }).map((_, i) => (
              <LoadingSkeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        </section>
      </div>

      {/* Activity log */}
      <section aria-hidden="true" className="rounded-lg border border-border bg-card px-4 py-3">
        <LoadingSkeleton className="mb-2 h-3 w-28" />
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <LoadingSkeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </section>
    </div>
  );
}
