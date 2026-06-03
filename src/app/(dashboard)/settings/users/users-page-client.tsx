"use client";

/**
 * UsersPageClient — client component for Settings > Users.
 *
 * Holds the Invite + Edit dialog state and the recent-action banner.
 * Receives pre-resolved row data + caller context from the server
 * component parent.
 *
 * UX5b (#184): added a per-row "Resend" action and a discriminated
 * `feedback` state replacing the prior `recentInvite: string | null`,
 * so the banner can render with the correct tone for invite-success /
 * resend-success / rate-limit / error.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/ui/banner";
import {
  InviteUserDialog,
  type OrgOption,
} from "@/components/users/InviteUserDialog";
import { EditUserDialog } from "@/components/users/EditUserDialog";
import { SUPER_ADMIN, ORG_MANAGER, SCOPE_ORG } from "@/lib/roles";
import type { UserVisibleRow, UserRole } from "@/lib/types/domain";

export interface UsersPageClientProps {
  rows: UserVisibleRow[];
  orgs: OrgOption[];
  callerRole: "super_admin" | "org_manager";
  callerOrgIds: string[];
  currentUserId: string;
}

/**
 * Discriminated union for the page-level banner. The `kind` keeps the
 * UX-tone-to-state mapping in a single place — see render block.
 */
type PageFeedback =
  | { kind: "invite"; email: string }
  | { kind: "resend"; email: string }
  | { kind: "rate-limit"; email: string }
  | { kind: "error"; email: string; message: string };

export function UsersPageClient(props: UsersPageClientProps) {
  const router = useRouter();
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<UserVisibleRow | null>(
    null
  );
  const [feedback, setFeedback] = React.useState<PageFeedback | null>(null);

  // Per-row in-flight resend state. A Set keeps the membership check
  // O(1) and avoids per-row component state explosion.
  const [resendingIds, setResendingIds] = React.useState<Set<string>>(
    () => new Set()
  );

  const orgNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const o of props.orgs) m.set(o.id, o.name);
    return m;
  }, [props.orgs]);

  // super_admin can change any role. org_manager cannot change roles.
  const canChangeRoleAny = props.callerRole === SUPER_ADMIN;

  function canRevokeFor(row: UserVisibleRow): boolean {
    if (row.user_id === props.currentUserId) return false;
    if (props.callerRole === SUPER_ADMIN) return true;
    // org_manager can revoke rows scoped to an org they manage.
    if (
      row.scope_type === "org" &&
      row.scope_id != null &&
      props.callerOrgIds.includes(row.scope_id)
    ) {
      return true;
    }
    return false;
  }

  /**
   * Mirror the resend-route permission rule (AC1):
   *   - super_admin: always allowed.
   *   - org_manager: only when the row is org_manager-scoped to an
   *     org the caller can access. Orphans (role === null) are hidden
   *     for org_managers — they would 403 at the route.
   *
   * Hidden (not disabled) on Active rows so the action surface only
   * shows up where it is meaningful.
   */
  function canResendFor(row: UserVisibleRow): boolean {
    if (!row.user_id) return false;
    if (row.email_confirmed_at != null) return false; // Active
    if (props.callerRole === SUPER_ADMIN) return true;
    if (
      row.role === ORG_MANAGER &&
      row.scope_type === SCOPE_ORG &&
      row.scope_id != null &&
      props.callerOrgIds.includes(row.scope_id)
    ) {
      return true;
    }
    return false;
  }

  function roleLabel(role: UserRole | null): string {
    if (role === "super_admin") return "Super admin";
    if (role === "org_manager") return "Org manager";
    return "—";
  }

  function scopeLabel(row: UserVisibleRow): string {
    if (row.role === "super_admin") return "All orgs";
    if (row.scope_id) return orgNameById.get(row.scope_id) ?? row.scope_id;
    return "—";
  }

  function statusLabel(row: UserVisibleRow): string {
    return row.email_confirmed_at == null ? "Invited" : "Active";
  }

  async function handleResendRow(row: UserVisibleRow) {
    if (!row.user_id) return;
    const userId = row.user_id;
    const email = row.email ?? "";
    setFeedback(null);
    setResendingIds((prev) => {
      const next = new Set(prev);
      next.add(userId);
      return next;
    });
    try {
      const res = await fetch(`/api/users/${userId}/resend-invite`, {
        method: "POST",
      });
      if (res.ok) {
        setFeedback({ kind: "resend", email });
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      if (res.status === 429 || data.code === "rate_limited") {
        setFeedback({ kind: "rate-limit", email });
        return;
      }
      setFeedback({
        kind: "error",
        email,
        message: data.error ?? "Could not resend invitation.",
      });
    } catch {
      setFeedback({
        kind: "error",
        email,
        message: "Network error. Please retry.",
      });
    } finally {
      setResendingIds((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Users</h2>
        <button
          onClick={() => setInviteOpen(true)}
          className="inline-flex h-9 items-center rounded-md border border-primary bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          + Invite user
        </button>
      </div>

      {feedback?.kind === "invite" && (
        <Banner tone="success" title="Invitation sent">
          Invitation sent to {feedback.email}.
        </Banner>
      )}
      {feedback?.kind === "resend" && (
        <Banner tone="success" title="Invitation resent">
          Invitation resent to {feedback.email}.
        </Banner>
      )}
      {feedback?.kind === "rate-limit" && (
        <Banner tone="warn" title="Rate limited">
          Too many invitations sent recently. Try again in a few minutes.
        </Banner>
      )}
      {feedback?.kind === "error" && (
        <Banner tone="destructive" title="Could not resend invitation">
          {feedback.message}
        </Banner>
      )}

      {props.rows.length === 0 ? (
        <div className="rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          <p>No users yet. Invite the first one.</p>
          <button
            onClick={() => setInviteOpen(true)}
            className="mt-3 inline-flex h-9 items-center rounded-md border border-primary bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            + Invite user
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                  First name
                </th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                  Last name
                </th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                  Email
                </th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                  Phone
                </th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                  Role
                </th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                  Scope
                </th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                  Status
                </th>
                <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row, idx) => {
                const showResend = canResendFor(row);
                const isResending =
                  row.user_id != null && resendingIds.has(row.user_id);
                return (
                  <tr
                    key={row.user_id ?? row.email ?? `row-${idx}`}
                    className="border-t border-border"
                  >
                    <td className="px-4 py-2 text-foreground">
                      {row.first_name ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-foreground">
                      {row.last_name ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-foreground">
                      {row.email ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-foreground">
                      {row.phone ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-foreground">
                      {roleLabel(row.role)}
                    </td>
                    <td className="px-4 py-2 text-foreground">
                      {scopeLabel(row)}
                    </td>
                    <td className="px-4 py-2 text-foreground">
                      {statusLabel(row)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="inline-flex items-center gap-2">
                        {showResend && (
                          <button
                            onClick={() => handleResendRow(row)}
                            disabled={isResending}
                            className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:cursor-not-allowed"
                          >
                            {isResending ? "Sending…" : "Resend"}
                          </button>
                        )}
                        <button
                          onClick={() => setEditTarget(row)}
                          className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <InviteUserDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        callerRole={props.callerRole}
        orgs={props.orgs}
        callerOrgIds={props.callerOrgIds}
        onSuccess={({ email }) => setFeedback({ kind: "invite", email })}
      />

      {editTarget && editTarget.user_id && (
        <EditUserDialog
          open={!!editTarget}
          onOpenChange={(open) => {
            if (!open) setEditTarget(null);
          }}
          target={{
            user_id: editTarget.user_id,
            email: editTarget.email ?? "",
            first_name: editTarget.first_name,
            last_name: editTarget.last_name,
            phone: editTarget.phone,
            role: editTarget.role,
            scope_id: editTarget.scope_id,
            email_confirmed_at: editTarget.email_confirmed_at,
          }}
          callerRole={props.callerRole}
          canChangeRole={canChangeRoleAny}
          canRevoke={canRevokeFor(editTarget)}
          orgs={props.orgs}
          onSuccess={() => setEditTarget(null)}
        />
      )}
    </div>
  );
}
