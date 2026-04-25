"use client";

/**
 * EditEntityButton — client wrapper that opens <EntityForm mode='edit'> (#76).
 *
 * Pre-fills the form from `initialValues` passed in by the parent server
 * component (cached listing/detail row). Concurrent-edit last-writer-wins
 * per ticket Out of Scope.
 */

import * as React from "react";
import { EntityForm } from "./EntityForm";
import type { Organization, Community, Microgrid } from "@/lib/types/domain";

type Props =
  | {
      entity: "organization";
      initialValues: Organization;
      label?: string;
      className?: string;
    }
  | {
      entity: "community";
      initialValues: Community;
      label?: string;
      className?: string;
    }
  | {
      entity: "microgrid";
      // Omit the encrypted ciphertext column so SSR-rendered HTML / client
      // components never receive it (defense-in-depth, see issue #106).
      initialValues: Omit<Microgrid, "ems_aws_secret_access_key_encrypted">;
      label?: string;
      className?: string;
    };

export function EditEntityButton(props: Props) {
  const [open, setOpen] = React.useState(false);

  const btnCls =
    "inline-flex items-center rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={props.className ?? btnCls}
      >
        {props.label ?? "Edit"}
      </button>
      {props.entity === "organization" && (
        <EntityForm
          entity="organization"
          mode="edit"
          initialValues={props.initialValues}
          open={open}
          onOpenChange={setOpen}
        />
      )}
      {props.entity === "community" && (
        <EntityForm
          entity="community"
          mode="edit"
          parentOrgId={props.initialValues.org_id}
          initialValues={props.initialValues}
          open={open}
          onOpenChange={setOpen}
        />
      )}
      {props.entity === "microgrid" && (
        <EntityForm
          entity="microgrid"
          mode="edit"
          parentCommunityId={props.initialValues.community_id}
          initialValues={props.initialValues}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}
