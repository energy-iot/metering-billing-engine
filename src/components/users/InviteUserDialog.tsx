"use client";

/**
 * InviteUserDialog — Invite a new user into MBE (UX5 / #79).
 *
 * Caller-role-scoped UI:
 *   - super_admin: role select (super_admin | org_manager); when
 *     org_manager is selected, an org select (from props.orgs) appears.
 *   - org_manager: role locked to org_manager; scope locked to their
 *     own org (callerOrgIds[0]) — no selects rendered.
 *
 * Submits to POST /api/users/invite via fetch. On success: closes,
 * refreshes, and calls onSuccess (caller surfaces a success banner on
 * the parent page).
 */
import * as React from "react";
import { useRouter } from "next/navigation";
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
import { SUPER_ADMIN, ORG_MANAGER } from "@/lib/roles";
import type { UserRole } from "@/lib/types/domain";
import { cn } from "@/lib/utils";

export interface OrgOption {
  id: string;
  name: string;
}

export interface InviteUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  callerRole: "super_admin" | "org_manager";
  /** Orgs the caller can invite into. super_admin: all orgs. org_manager: their orgs. */
  orgs: OrgOption[];
  /** Fallback org ids for an org_manager caller (first item used). */
  callerOrgIds: string[];
  onSuccess?: (payload: { email: string }) => void;
}

type FieldErrors = Partial<Record<string, string>>;

export function InviteUserDialog(props: InviteUserDialogProps) {
  const router = useRouter();

  // Default to org_manager regardless of caller role. super_admin most commonly
  // invites an org_manager (the new Aaron onboarding case); they can select
  // super_admin from the role dropdown when needed.
  const defaultRole: UserRole = ORG_MANAGER;
  const defaultScope =
    props.callerRole === "org_manager"
      ? (props.callerOrgIds[0] ?? "")
      : (props.orgs[0]?.id ?? "");

  const [email, setEmail] = React.useState("");
  const [firstName, setFirstName] = React.useState("");
  const [lastName, setLastName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [role, setRole] = React.useState<UserRole>(defaultRole);
  const [scopeId, setScopeId] = React.useState<string>(defaultScope);
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [topError, setTopError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Reset form whenever the dialog opens.
  React.useEffect(() => {
    if (props.open) {
      setEmail("");
      setFirstName("");
      setLastName("");
      setPhone("");
      setRole(defaultRole);
      setScopeId(defaultScope);
      setFieldErrors({});
      setTopError(null);
      setSubmitting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const showRoleSelect = props.callerRole === "super_admin";
  const showOrgSelect =
    props.callerRole === "super_admin" && role === ORG_MANAGER;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTopError(null);

    // Client-side sanity checks.
    const errs: FieldErrors = {};
    if (!email.trim()) {
      errs.email = "Email is required.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errs.email = "Enter a valid email address.";
    }
    if (role === ORG_MANAGER && !scopeId) {
      errs.scope_id = "Please choose an organization.";
    }
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          phone: phone.trim(),
          role,
          scope_id: role === ORG_MANAGER ? scopeId : null,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        field?: string;
      };

      if (!res.ok) {
        if (res.status === 422 && data.field) {
          setFieldErrors({ [data.field]: data.error ?? "Invalid value." });
        } else if (res.status === 403) {
          setTopError(
            data.error ?? "You do not have permission to invite this user."
          );
        } else if (res.status === 409) {
          const msg = data.error ?? "User already exists in MBE.";
          setTopError(msg);
          setFieldErrors({ email: msg });
        } else {
          setTopError(data.error ?? "Could not send invitation. Please retry.");
        }
        setSubmitting(false);
        return;
      }

      props.onSuccess?.({ email: email.trim() });
      router.refresh();
      props.onOpenChange(false);
    } catch {
      setTopError("Network error. Please retry.");
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
              Invite user
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] text-muted-foreground">
              An invitation email with a magic-link sign-in will be sent.
            </Dialog.Description>
          </div>

          <form onSubmit={handleSubmit} className="px-6 pb-2 pt-4 space-y-4" noValidate>
            {topError && (
              <Banner tone="destructive" title="Could not send invitation">
                {topError}
              </Banner>
            )}

            {/* Email */}
            <div>
              <label
                htmlFor="invite-email"
                className="mb-1 block text-xs font-medium text-muted-foreground"
              >
                Email
                <span aria-hidden="true" className="ml-0.5 text-destructive-fg">*</span>
                <span className="sr-only"> (required)</span>
              </label>
              <Input
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                aria-invalid={fieldErrors.email ? true : undefined}
                aria-describedby={fieldErrors.email ? "invite-email-err" : undefined}
                className={cn(fieldErrors.email && "border-destructive")}
              />
              {fieldErrors.email && (
                <p id="invite-email-err" role="alert" className="mt-1 text-xs text-destructive-fg">
                  {fieldErrors.email}
                </p>
              )}
            </div>

            {/* Name / Phone */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="invite-first" className="mb-1 block text-xs font-medium text-muted-foreground">
                  First name
                </label>
                <Input
                  id="invite-first"
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div>
                <label htmlFor="invite-last" className="mb-1 block text-xs font-medium text-muted-foreground">
                  Last name
                </label>
                <Input
                  id="invite-last"
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  disabled={submitting}
                />
              </div>
            </div>

            <div>
              <label htmlFor="invite-phone" className="mb-1 block text-xs font-medium text-muted-foreground">
                Phone
              </label>
              <Input
                id="invite-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={submitting}
              />
            </div>

            {/* Role (super_admin only) */}
            {showRoleSelect && (
              <div>
                <label
                  htmlFor="invite-role"
                  className="mb-1 block text-xs font-medium text-muted-foreground"
                >
                  Role
                </label>
                <Select
                  value={role}
                  onValueChange={(v) => setRole(v as UserRole)}
                  disabled={submitting}
                >
                  <SelectTrigger id="invite-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SUPER_ADMIN}>Super admin</SelectItem>
                    <SelectItem value={ORG_MANAGER}>Org manager</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Org scope */}
            {showOrgSelect && (
              <div>
                <label
                  htmlFor="invite-org"
                  className="mb-1 block text-xs font-medium text-muted-foreground"
                >
                  Organization
                  <span aria-hidden="true" className="ml-0.5 text-destructive-fg">*</span>
                </label>
                <Select
                  value={scopeId}
                  onValueChange={setScopeId}
                  disabled={submitting}
                >
                  <SelectTrigger id="invite-org" className="w-full">
                    <SelectValue placeholder="Choose an organization" />
                  </SelectTrigger>
                  <SelectContent>
                    {props.orgs.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fieldErrors.scope_id && (
                  <p role="alert" className="mt-1 text-xs text-destructive-fg">
                    {fieldErrors.scope_id}
                  </p>
                )}
              </div>
            )}

            {/* For org_manager caller: show locked-in context. */}
            {props.callerRole === "org_manager" && (
              <p className="text-xs text-muted-foreground">
                This user will be invited as an org manager for your
                organization.
              </p>
            )}

            <div className="mt-4 flex items-center justify-end gap-2 bg-muted px-6 pb-[18px] pt-[14px] -mx-6 -mb-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="inline-flex h-8 items-center rounded-md px-3.5 text-[13px] font-medium text-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex h-8 items-center rounded-md border border-primary bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {submitting ? "Sending..." : "Send invitation"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
