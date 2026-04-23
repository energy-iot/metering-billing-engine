"use client";

/**
 * UsersPageClient — client component for Settings > Users.
 *
 * Holds the Invite + Edit dialog state and the recent-invite success
 * banner. Receives pre-resolved row data + caller context from the
 * server component parent.
 */
import * as React from "react";
import { Banner } from "@/components/ui/banner";
import {
  InviteUserDialog,
  type OrgOption,
} from "@/components/users/InviteUserDialog";
import { EditUserDialog } from "@/components/users/EditUserDialog";
import { SUPER_ADMIN } from "@/lib/roles";
import type { UserDirectoryRow, UserRole } from "@/lib/types/domain";

export interface UsersPageClientProps {
  rows: UserDirectoryRow[];
  orgs: OrgOption[];
  callerRole: "super_admin" | "org_manager";
  callerOrgIds: string[];
  currentUserId: string;
}

export function UsersPageClient(props: UsersPageClientProps) {
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<UserDirectoryRow | null>(
    null
  );
  const [recentInvite, setRecentInvite] = React.useState<string | null>(null);

  const orgNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const o of props.orgs) m.set(o.id, o.name);
    return m;
  }, [props.orgs]);

  // super_admin can change any role. org_manager cannot change roles.
  const canChangeRoleAny = props.callerRole === SUPER_ADMIN;

  function canRevokeFor(row: UserDirectoryRow): boolean {
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

  function roleLabel(role: UserRole | null): string {
    if (role === "super_admin") return "Super admin";
    if (role === "org_manager") return "Org manager";
    return "—";
  }

  function scopeLabel(row: UserDirectoryRow): string {
    if (row.role === "super_admin") return "All orgs";
    if (row.scope_id) return orgNameById.get(row.scope_id) ?? row.scope_id;
    return "—";
  }

  function statusLabel(row: UserDirectoryRow): string {
    return row.email_confirmed_at == null ? "Invited" : "Active";
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

      {recentInvite && (
        <Banner tone="success" title="Invitation sent">
          Invitation sent to {recentInvite}.
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
              {props.rows.map((row, idx) => (
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
                    <button
                      onClick={() => setEditTarget(row)}
                      className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
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
        onSuccess={({ email }) => setRecentInvite(email)}
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
