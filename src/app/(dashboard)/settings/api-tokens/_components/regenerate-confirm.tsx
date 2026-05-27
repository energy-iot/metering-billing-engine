"use client";

import * as React from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export interface RegenerateConfirmProps {
  open: boolean;
  tokenName: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}

/**
 * RegenerateConfirm — thin wrapper over <ConfirmDialog tone="destructive">
 * that pins the hard-cutover warning copy required by #256 (Architect
 * appendix):
 *
 *   "Old token will be revoked immediately. Any customerapp instance
 *    still using the old token will get 401 errors until you update its
 *    configuration. Are you sure you want to regenerate?"
 *
 * Confirm button label flips to "Regenerate and revoke old" — matches
 * the established explicit-destructive-verb pattern (ClosePeriodDialog
 * "Close anyway"). This is NOT a generic regenerate button; the explicit
 * destructive verb is the operator's acknowledgement of the cutover.
 */
export function RegenerateConfirm(props: RegenerateConfirmProps) {
  return (
    <ConfirmDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      tone="destructive"
      eyebrow="Hard cutover"
      title={
        props.tokenName
          ? `Regenerate "${props.tokenName}"?`
          : "Regenerate token"
      }
      description={
        "Old token will be revoked immediately. Any customerapp instance still using the old token will get 401 errors until you update its configuration. Are you sure you want to regenerate?"
      }
      confirmLabel="Regenerate and revoke old"
      onConfirm={props.onConfirm}
    />
  );
}
