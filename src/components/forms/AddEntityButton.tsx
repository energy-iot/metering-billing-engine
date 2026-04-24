"use client";

/**
 * AddEntityButton — client wrapper that opens <EntityForm mode='create'> (#76).
 *
 * Renders a button; when clicked, opens the shared EntityForm in create mode.
 * Parent (server component) supplies the entity kind and any parent IDs.
 * Label defaults to "+ Add {Entity}" but can be overridden (empty-state CTA).
 *
 * Multi-parent picker mode (#132):
 *   - entity="community": pass either `parentOrgId` (locked single-parent) OR
 *     `availableOrgs` (renders a parent-picker select in the form).
 *   - entity="microgrid": pass either `parentCommunityId` OR
 *     `availableCommunities` (picker). When communities span multiple orgs,
 *     include `org_name` on each item so the form can disambiguate labels.
 */

import * as React from "react";
import { EntityForm } from "./EntityForm";

/** Items for the organization picker (community creation). */
export type OrgOption = { id: string; name: string };

/** Items for the community picker (microgrid creation). */
export type CommunityOption = { id: string; name: string; org_name?: string };

type Props =
  | {
      entity: "organization";
      label?: string;
      className?: string;
      variant?: "primary" | "secondary";
    }
  | {
      entity: "community";
      /** Single-parent locked mode — picker is hidden. */
      parentOrgId: string;
      availableOrgs?: never;
      label?: string;
      className?: string;
      variant?: "primary" | "secondary";
    }
  | {
      entity: "community";
      /** Multi-parent picker mode — user selects the org in the form. */
      availableOrgs: OrgOption[];
      parentOrgId?: never;
      label?: string;
      className?: string;
      variant?: "primary" | "secondary";
    }
  | {
      entity: "microgrid";
      /** Single-parent locked mode — picker is hidden. */
      parentCommunityId: string;
      availableCommunities?: never;
      label?: string;
      className?: string;
      variant?: "primary" | "secondary";
    }
  | {
      entity: "microgrid";
      /** Multi-parent picker mode — user selects the community in the form. */
      availableCommunities: CommunityOption[];
      parentCommunityId?: never;
      label?: string;
      className?: string;
      variant?: "primary" | "secondary";
    };

export function AddEntityButton(props: Props) {
  const [open, setOpen] = React.useState(false);

  const defaultLabel =
    props.entity === "organization"
      ? "+ Add Organization"
      : props.entity === "community"
        ? "+ Add Community"
        : "+ Add Microgrid";

  const variant = props.variant ?? "primary";
  const btnCls =
    variant === "primary"
      ? "inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
      : "inline-flex items-center rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={props.className ?? btnCls}
      >
        {props.label ?? defaultLabel}
      </button>
      {props.entity === "organization" && (
        <EntityForm
          entity="organization"
          mode="create"
          open={open}
          onOpenChange={setOpen}
        />
      )}
      {props.entity === "community" && props.parentOrgId != null && (
        <EntityForm
          entity="community"
          mode="create"
          parentOrgId={props.parentOrgId}
          open={open}
          onOpenChange={setOpen}
        />
      )}
      {props.entity === "community" && props.availableOrgs != null && (
        <EntityForm
          entity="community"
          mode="create"
          availableOrgs={props.availableOrgs}
          open={open}
          onOpenChange={setOpen}
        />
      )}
      {props.entity === "microgrid" && props.parentCommunityId != null && (
        <EntityForm
          entity="microgrid"
          mode="create"
          parentCommunityId={props.parentCommunityId}
          open={open}
          onOpenChange={setOpen}
        />
      )}
      {props.entity === "microgrid" && props.availableCommunities != null && (
        <EntityForm
          entity="microgrid"
          mode="create"
          availableCommunities={props.availableCommunities}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}
