// Billing period detail loading fallback.
//
// Shown while billing/[periodId]/page.tsx (period + line items + households +
// edges + schedule + microgrid + actors) resolves. Mirrors the page's frame —
// breadcrumb, period header card, CopyTable card with header + body rows,
// grand-total footer — so the table doesn't jump when rows land.

import { LoadingSkeleton } from "@/components/ui/loading-skeleton";

const ROWS = 8;

export default function BillingPeriodDetailLoading() {
  return (
    <div role="status" aria-label="Loading billing period" aria-busy="true" className="space-y-4">
      <span className="sr-only">Loading billing period…</span>

      {/* Breadcrumb */}
      <div className="mb-4 flex gap-1">
        <LoadingSkeleton className="h-9 w-36" />
        <LoadingSkeleton className="h-9 w-28" />
        <LoadingSkeleton className="h-9 w-40" />
      </div>

      {/* Period header card (picker + actions row) */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <LoadingSkeleton className="h-9 w-64" />
        <div className="flex gap-2">
          <LoadingSkeleton className="h-9 w-28" />
          <LoadingSkeleton className="h-9 w-28" />
        </div>
      </div>

      {/* CopyTable card */}
      <div aria-hidden="true" className="rounded-lg border border-border bg-card p-6">
        {/* Header row */}
        <div className="grid grid-cols-4 gap-3 border-b border-border pb-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <LoadingSkeleton key={i} className="h-4 w-3/4" />
          ))}
        </div>
        {/* Body rows */}
        <div className="divide-y divide-border">
          {Array.from({ length: ROWS }).map((_, i) => (
            <div key={i} className="grid grid-cols-4 gap-3 py-3">
              <LoadingSkeleton className="h-5 w-full" />
              <LoadingSkeleton className="h-5 w-2/3" />
              <LoadingSkeleton className="h-5 w-1/2" />
              <LoadingSkeleton className="ml-auto h-5 w-2/3" />
            </div>
          ))}
        </div>
        {/* Grand-total footer */}
        <div className="mt-2 flex justify-end border-t border-border pt-3">
          <LoadingSkeleton className="h-5 w-48" />
        </div>
      </div>
    </div>
  );
}
