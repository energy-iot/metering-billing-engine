"use client";

/**
 * AddEntityButton — client wrapper that opens <EntityForm mode='create'> (#76).
 *
 * Renders a button; when clicked, opens the shared EntityForm in create mode.
 * Parent (server component) supplies the entity kind and any parent IDs.
 * Label defaults to "+ Add {Entity}" but can be overridden (empty-state CTA).
 */

import * as React from "react";
import { EntityForm } from "./EntityForm";

type Props =
  | {
      entity: "organization";
      label?: string;
      className?: string;
      variant?: "primary" | "secondary";
    }
  | {
      entity: "community";
      parentOrgId: string;
      label?: string;
      className?: string;
      variant?: "primary" | "secondary";
    }
  | {
      entity: "microgrid";
      parentCommunityId: string;
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
      {props.entity === "community" && (
        <EntityForm
          entity="community"
          mode="create"
          parentOrgId={props.parentOrgId}
          open={open}
          onOpenChange={setOpen}
        />
      )}
      {props.entity === "microgrid" && (
        <EntityForm
          entity="microgrid"
          mode="create"
          parentCommunityId={props.parentCommunityId}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}
