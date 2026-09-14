// Microgrid section loading fallback.
//
// Generic minimal frame for the whole `microgrids/[id]` subtree (setup/*,
// tenants, billing list). Deliberately NOT overview-specific: App Router
// `loading.tsx` wraps its segment's page AND all children, so an
// overview-shaped skeleton here would flash the wrong frame on e.g. the
// rates or households pages (pr-375 review). The overview page itself gets
// its precise skeleton from the `(overview)` route group, which is
// URL-transparent and takes precedence for that route.
//
// Accessibility: single role="status" announcer; all blocks decorative.

import { LoadingSkeleton } from "@/components/ui/loading-skeleton";

export default function MicrogridSectionLoading() {
  return (
    <div role="status" aria-label="Loading microgrid" aria-busy="true" className="space-y-4">
      <span className="sr-only">Loading microgrid…</span>

      {/* Breadcrumb row */}
      <div className="flex gap-1">
        <LoadingSkeleton className="h-9 w-36" />
        <LoadingSkeleton className="h-9 w-28" />
      </div>

      {/* Generic content cards */}
      <div aria-hidden="true" className="rounded-lg border border-border bg-card px-4 py-3">
        <LoadingSkeleton className="mb-2 h-3 w-24" />
        <LoadingSkeleton className="h-8 w-full" />
      </div>
      <div aria-hidden="true" className="rounded-lg border border-border bg-card px-4 py-3">
        <LoadingSkeleton className="mb-2 h-3 w-32" />
        <div className="space-y-2">
          <LoadingSkeleton className="h-5 w-full" />
          <LoadingSkeleton className="h-5 w-11/12" />
          <LoadingSkeleton className="h-5 w-4/5" />
        </div>
      </div>
    </div>
  );
}
