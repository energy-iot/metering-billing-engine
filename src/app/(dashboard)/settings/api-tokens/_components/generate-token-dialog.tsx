"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Input } from "@/components/ui/input";
import { Banner } from "@/components/ui/banner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface OrgOption {
  id: string;
  name: string;
}

export interface GenerateTokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgs: OrgOption[];
  callerRole: "super_admin" | "org_manager";
  /** Invoked once the POST succeeds. The parent surfaces the plaintext
   *  in <TokenRevealModal>; this dialog hands it up and closes. */
  onGenerated: (plaintext: string, successMessage: string) => Promise<void>;
}

/**
 * GenerateTokenDialog — name + org pickers, POSTs to /api/org-api-tokens,
 * hands the plaintext up to the parent which renders it ONCE in
 * <TokenRevealModal>. No retention of plaintext in this component's
 * state — it never lands in any state the dialog can re-render from.
 */
export function GenerateTokenDialog(props: GenerateTokenDialogProps) {
  // Default org: only auto-pick when there's exactly one (org_manager
  // case, or super_admin with a single org). Otherwise force the
  // operator to choose so they can't accidentally generate a token under
  // the wrong org.
  const defaultOrgId = props.orgs.length === 1 ? props.orgs[0].id : "";

  const [name, setName] = React.useState("");
  const [orgId, setOrgId] = React.useState(defaultOrgId);
  const [fieldErrors, setFieldErrors] = React.useState<
    Partial<Record<string, string>>
  >({});
  const [topError, setTopError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Reset form whenever the dialog opens.
  React.useEffect(() => {
    if (props.open) {
      setName("");
      setOrgId(defaultOrgId);
      setFieldErrors({});
      setTopError(null);
      setSubmitting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTopError(null);

    const errs: Partial<Record<string, string>> = {};
    const trimmedName = name.trim();
    if (!trimmedName) {
      errs.name = "Name is required.";
    } else if (trimmedName.length > 120) {
      errs.name = "Name must be 120 characters or fewer.";
    }
    if (!orgId) {
      errs.org_id = "Select an organisation.";
    }
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/org-api-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName, org_id: orgId }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        plaintext?: string;
        error?: string;
        field?: string;
      };
      if (!res.ok) {
        if (body.field) {
          setFieldErrors({ [body.field]: body.error ?? "Invalid value." });
        } else {
          setTopError(body.error ?? "Failed to generate token.");
        }
        return;
      }
      if (!body.plaintext) {
        setTopError("Token created but the server did not return the plaintext.");
        return;
      }
      await props.onGenerated(
        body.plaintext,
        `Token "${trimmedName}" created. Copy the plaintext now — it cannot be retrieved later.`
      );
      props.onOpenChange(false);
    } catch (err) {
      setTopError(
        err instanceof Error ? err.message : "Failed to generate token."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/55" />
        <Dialog.Content
          aria-modal
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[480px] max-w-[94%] -translate-x-1/2 -translate-y-1/2",
            "max-h-[90vh] overflow-y-auto rounded-md border border-border bg-card shadow-elev-3 outline-none"
          )}
        >
          <div className="px-6 pt-5">
            <Dialog.Title className="text-xl font-semibold tracking-tight text-foreground">
              Generate API token
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] text-muted-foreground">
              You will see the plaintext once. Save it immediately — it
              cannot be retrieved later.
            </Dialog.Description>
          </div>

          <form onSubmit={handleSubmit} noValidate>
            <div className="space-y-4 px-6 pb-2 pt-4">
            {topError && (
              <Banner tone="destructive" title="Could not generate token">
                {topError}
              </Banner>
            )}

            <div>
              <label
                htmlFor="generate-token-name"
                className="mb-1 block text-xs font-medium text-muted-foreground"
              >
                Name
                <span aria-hidden="true" className="ml-0.5 text-destructive-fg">
                  *
                </span>
                <span className="sr-only"> (required)</span>
              </label>
              <Input
                id="generate-token-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. customerapp-prod-2026"
                disabled={submitting}
                aria-invalid={fieldErrors.name ? true : undefined}
                aria-describedby={
                  fieldErrors.name ? "generate-token-name-err" : undefined
                }
                className={cn(fieldErrors.name && "border-destructive")}
              />
              {fieldErrors.name && (
                <p
                  id="generate-token-name-err"
                  role="alert"
                  className="mt-1 text-xs text-destructive-fg"
                >
                  {fieldErrors.name}
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                Shown in the audit log so you can identify which customerapp
                instance authenticated.
              </p>
            </div>

            {props.orgs.length > 1 ? (
              <div>
                <label
                  htmlFor="generate-token-org"
                  className="mb-1 block text-xs font-medium text-muted-foreground"
                >
                  Organisation
                  <span
                    aria-hidden="true"
                    className="ml-0.5 text-destructive-fg"
                  >
                    *
                  </span>
                </label>
                <Select
                  value={orgId}
                  onValueChange={(v) => setOrgId(v)}
                  disabled={submitting}
                >
                  <SelectTrigger id="generate-token-org" className="w-full">
                    <SelectValue placeholder="Select organisation" />
                  </SelectTrigger>
                  <SelectContent>
                    {props.orgs.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fieldErrors.org_id && (
                  <p
                    role="alert"
                    className="mt-1 text-xs text-destructive-fg"
                  >
                    {fieldErrors.org_id}
                  </p>
                )}
              </div>
            ) : (
              // Single-org caller — the org is implicit; we don't render a
              // picker but we DO show the org name so they know which scope
              // they're generating against.
              props.orgs[0] && (
                <p className="text-xs text-muted-foreground">
                  Generating for <strong>{props.orgs[0].name}</strong>.
                </p>
              )
            )}
            </div>

            <div className="flex items-center justify-end gap-2 bg-muted px-6 pb-[18px] pt-[14px]">
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={submitting}
                  className="inline-flex h-8 items-center rounded-md px-3.5 text-[13px] font-medium text-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex h-8 items-center gap-2 rounded-md border border-primary bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                {submitting && (
                  <svg
                    aria-hidden="true"
                    className="h-3.5 w-3.5 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                )}
                Generate token
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
