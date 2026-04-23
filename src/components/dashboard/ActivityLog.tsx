// ActivityLog — recent microgrid lifecycle events (last 10 entries).
//
// Renders a timeline list of events from the microgrid_recent_activity VIEW.
// Timestamps shown as relative ("3 hours ago") using a simple client-side helper.
// Empty state: "No recent activity."
//
// Wire-up notes:
//   - Mock events (reading polled, Tier-3 crossed, muscle-memory nudge) are
//     DEFERRED per ticket #73 out-of-scope. Only DB-derivable events are shown.
//   - Edge-offline transitions are DEFERRED (schema doesn't record status transitions).

"use client";

export type ActivityEvent = {
  kind: string;
  timestamp: string; // ISO timestamp
  description: string;
};

export type ActivityLogProps = {
  events: ActivityEvent[];
};

export function ActivityLog({ events }: ActivityLogProps) {
  return (
    <section
      aria-label="Recent activity"
      className="rounded-lg border border-border bg-card px-4 py-3"
    >
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Recent activity
      </p>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recent activity.</p>
      ) : (
        <ol className="space-y-3">
          {events.map((event, idx) => (
            <li key={idx} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-foreground">{event.description}</p>
                <p className="text-[11px] text-muted-foreground">
                  {relativeTime(event.timestamp)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Returns a human-readable relative time string (e.g. "3 hours ago", "2 days ago").
 * Uses a simple bucketed approach — no external dependency.
 */
function relativeTime(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;

  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;

  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths} month${diffMonths === 1 ? "" : "s"} ago`;
}
