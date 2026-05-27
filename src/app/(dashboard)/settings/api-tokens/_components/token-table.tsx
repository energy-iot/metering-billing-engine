"use client";

import * as React from "react";
import { LocalDateTime } from "@/components/format/local-date-time";

export interface TokenRow {
  id: string;
  org_id: string;
  name: string;
  env_prefix: string;
  token_lookup: string;
  created_at: string;
  created_by: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface TokenTableProps {
  rows: TokenRow[];
  orgNames: Record<string, string>;
  creatorNames: Record<string, string>;
  callerRole: "super_admin" | "org_manager";
  onRevoke: (row: TokenRow) => void;
  onRegenerate: (row: TokenRow) => void;
}

/**
 * TokenTable — read-only list of active per-org API tokens, with per-row
 * Revoke / Regenerate actions. NOT a <CopyTable> — the data here is
 * identification metadata (name, lookup prefix, dates) rather than the
 * tabular billing data that CopyTable optimises for. The plaintext token
 * is intentionally NOT in any cell (would defeat the one-time-display
 * invariant).
 *
 * The lookup-prefix cell is shown as a faint identifier so operators can
 * cross-reference the audit log without seeing the secret.
 *
 * Org column is rendered only for super_admin (who can manage multiple
 * orgs). org_manager scopes to a single org and the column would be
 * always-the-same noise.
 */
export function TokenTable(props: TokenTableProps) {
  const showOrg = props.callerRole === "super_admin";

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-card shadow-elev-1">
      <table className="w-full text-sm">
        <thead className="bg-muted text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Name
            </th>
            {showOrg && (
              <th scope="col" className="px-4 py-2.5 font-medium">
                Org
              </th>
            )}
            <th scope="col" className="px-4 py-2.5 font-medium">
              Identifier
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Created
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Created by
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Last used
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => {
            const creator =
              row.created_by !== null
                ? (props.creatorNames[row.created_by] ?? "Unknown user")
                : "Unknown user";
            const orgName = props.orgNames[row.org_id] ?? row.org_id;
            return (
              <tr
                key={row.id}
                className="border-t border-border hover:bg-muted/40"
              >
                <td className="px-4 py-3 font-medium text-foreground">
                  {row.name}
                </td>
                {showOrg && (
                  <td className="px-4 py-3 text-muted-foreground">
                    {orgName}
                  </td>
                )}
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  mbe_{row.env_prefix}_{row.token_lookup}_…
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  <LocalDateTime value={row.created_at} />
                </td>
                <td className="px-4 py-3 text-muted-foreground">{creator}</td>
                <td className="px-4 py-3 text-muted-foreground">
                  {row.last_used_at ? (
                    <LocalDateTime value={row.last_used_at} />
                  ) : (
                    <span className="italic">Never</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => props.onRegenerate(row)}
                      className="inline-flex h-7 items-center rounded-md border border-border bg-card px-2.5 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Regenerate
                    </button>
                    <button
                      type="button"
                      onClick={() => props.onRevoke(row)}
                      className="inline-flex h-7 items-center rounded-md border border-destructive/40 bg-card px-2.5 text-xs font-medium text-destructive-fg hover:bg-destructive-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Revoke
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
