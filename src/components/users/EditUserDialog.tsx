"use client";

/**
 * EditUserDialog — Edit an existing user (UX5 / #79).
 *
 * Two sections:
 *   1. Profile — first_name / last_name / phone editable; email
 *      read-only. PATCH /api/users/[id]/profile.
 *   2. Role — caller-role-scoped (same UI shape as InviteUserDialog).
 *      Only rendered if `canChangeRole` is true. PATCH
 *      /api/users/[id]/role.
 *
 * Revoke access — destructive confirm at the bottom. Only rendered
 * when `canRevoke` is true. Uses <ConfirmDialog tone="destructive">
 * and surfaces the backend trigger's error message directly on last-
 * super_admin / self-revoke attempts.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Input } from "@/components/ui/input";
import { Banner } from "@/components/ui/banner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SUPER_ADMIN, ORG_MANAGER } from "@/lib/roles";
import type { UserRole } from "@/lib/types/domain";
import type { OrgOption } from "./InviteUserDialog";
import { cn } from "@/lib/utils";

export interface EditUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: {
    user_id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    role: UserRole | null;
    scope_id: string | null;
    /**
     * NULL when the invited user has not yet accepted (status "Invited"),
     * non-null timestamp once accepted (status "Active"). The Resend
     * invitation button (UX5b / #184) only renders when this is null.
     */
    email_confirmed_at: string | null;
  };
  callerRole: "super_admin" | "org_manager";
  canChangeRole: boolean;
  canRevoke: boolean;
  /** Orgs the caller can assign. */
  orgs: OrgOption[];
  onSuccess?: () => void;
}

type FieldErrors = Partial<Record<string, string>>;

export function EditUserDialog(props: EditUserDialogProps) {
  const router = useRouter();
  const t = props.target;

  const [firstName, setFirstName] = React.useState(t.first_name ?? "");
  const [lastName, setLastName] = React.useState(t.last_name ?? "");
  const [phone, setPhone] = React.useState(t.phone ?? "");
  const [role, setRole] = React.useState<UserRole>(t.role ?? ORG_MANAGER);
  const [scopeId, setScopeId] = React.useState<string>(
    t.scope_id ?? (props.orgs[0]?.id ?? "")
  );

  const [, setFieldErrors] = React.useState<FieldErrors>({});
  const [topError, setTopError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // Resend-invitation state (UX5b / #184). Mirrors the
  // `submitting`/`topError` pattern used by the profile/role PATCH flow
  // so the dialog has a single, consistent async-state shape.
  type ResendFeedback =
    | { kind: "success" }
    | { kind: "rate-limit" }
    | { kind: "error"; message: string };
  const [resending, setResending] = React.useState(false);
  const [resendFeedback, setResendFeedback] =
    React.useState<ResendFeedback | null>(null);

  const showResend = t.email_confirmed_at == null;

  React.useEffect(() => {
    if (props.open) {
      setFirstName(t.first_name ?? "");
      setLastName(t.last_name ?? "");
      setPhone(t.phone ?? "");
      setRole(t.role ?? ORG_MANAGER);
      setScopeId(t.scope_id ?? (props.orgs[0]?.id ?? ""));
      setFieldErrors({});
      setTopError(null);
      setSubmitting(false);
      setConfirmOpen(false);
      setResending(false);
      setResendFeedback(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, t.user_id]);

  const showRoleSelect = props.callerRole === "super_admin";

  function computeProfilePatch(): Record<string, string | null> {
    const p: Record<string, string | null> = {};
    const norm = (s: string) => (s.trim() === "" ? null : s.trim());
    if (norm(firstName) !== (t.first_name ?? null))
      p.first_name = norm(firstName);
    if (norm(lastName) !== (t.last_name ?? null)) p.last_name = norm(lastName);
    if (norm(phone) !== (t.phone ?? null)) p.phone = norm(phone);
    return p;
  }

  function roleChanged(): boolean {
    if (!props.canChangeRole) return false;
    const nextScope = role === SUPER_ADMIN ? null : scopeId;
    return role !== t.role || nextScope !== t.scope_id;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTopError(null);
    setFieldErrors({});

    const profilePatch = computeProfilePatch();
    const needsRolePatch = roleChanged();

    if (Object.keys(profilePatch).length === 0 && !needsRolePatch) {
      props.onOpenChange(false);
      return;
    }

    setSubmitting(true);
    try {
      // Profile PATCH first.
      if (Object.keys(profilePatch).length > 0) {
        const res = await fetch(`/api/users/${t.user_id}/profile`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(profilePatch),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
            field?: string;
          };
          if (res.status === 422 && data.field) {
            setFieldErrors({ [data.field]: data.error ?? "Invalid." });
          } else {
            setTopError(data.error ?? "Failed to update profile.");
          }
          setSubmitting(false);
          return;
        }
      }

      // Role PATCH next (separate call so partial successes surface cleanly).
      if (needsRolePatch) {
        const res = await fetch(`/api/users/${t.user_id}/role`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role,
            scope_id: role === ORG_MANAGER ? scopeId : null,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setTopError(data.error ?? "Failed to change role.");
          setSubmitting(false);
          return;
        }
      }

      props.onSuccess?.();
      router.refresh();
      props.onOpenChange(false);
    } catch {
      setTopError("Network error. Please retry.");
      setSubmitting(false);
    }
  }

  async function handleRevoke() {
    const res = await fetch(`/api/users/${t.user_id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? "Failed to revoke access.");
    }
    props.onSuccess?.();
    router.refresh();
    props.onOpenChange(false);
  }

  // Resend invitation handler (UX5b / #184). Stays in the dialog (no
  // dismissal) so the operator gets explicit in-context confirmation
  // via an inline <Banner>.
  async function handleResend() {
    setResending(true);
    setResendFeedback(null);
    try {
      const res = await fetch(`/api/users/${t.user_id}/resend-invite`, {
        method: "POST",
      });
      if (res.ok) {
        setResendFeedback({ kind: "success" });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      if (res.status === 429 || data.code === "rate_limited") {
        setResendFeedback({ kind: "rate-limit" });
        return;
      }
      setResendFeedback({
        kind: "error",
        message: data.error ?? "Could not resend invitation.",
      });
    } catch {
      setResendFeedback({
        kind: "error",
        message: "Network error. Please retry.",
      });
    } finally {
      setResending(false);
    }
  }

  return (
    <>
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
                Edit user
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] text-muted-foreground">
                Update profile and role. Contact admin to change email.
              </Dialog.Description>
            </div>

            <form onSubmit={handleSubmit} className="px-6 pb-2 pt-4 space-y-4" noValidate>
              {topError && (
                <Banner tone="destructive" title="Could not save">
                  {topError}
                </Banner>
              )}

              {/* Profile */}
              <div>
                <h3 className="text-sm font-semibold text-foreground">
                  Profile
                </h3>
                <div className="mt-3 space-y-3">
                  <div>
                    <label
                      htmlFor="edit-email"
                      className="mb-1 block text-xs font-medium text-muted-foreground"
                    >
                      Email
                    </label>
                    <Input
                      id="edit-email"
                      type="email"
                      value={t.email}
                      readOnly
                      disabled
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Contact admin to change email.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor="edit-first"
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                      >
                        First name
                      </label>
                      <Input
                        id="edit-first"
                        type="text"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        disabled={submitting}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="edit-last"
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                      >
                        Last name
                      </label>
                      <Input
                        id="edit-last"
                        type="text"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        disabled={submitting}
                      />
                    </div>
                  </div>
                  <div>
                    <label
                      htmlFor="edit-phone"
                      className="mb-1 block text-xs font-medium text-muted-foreground"
                    >
                      Phone
                    </label>
                    <Input
                      id="edit-phone"
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      disabled={submitting}
                    />
                  </div>
                </div>
              </div>

              {/* Role */}
              {props.canChangeRole && (
                <div>
                  <h3 className="text-sm font-semibold text-foreground">Role</h3>
                  <div className="mt-3 space-y-3">
                    {showRoleSelect && (
                      <div>
                        <label
                          htmlFor="edit-role"
                          className="mb-1 block text-xs font-medium text-muted-foreground"
                        >
                          Role
                        </label>
                        <Select
                          value={role}
                          onValueChange={(v) => setRole(v as UserRole)}
                          disabled={submitting}
                        >
                          <SelectTrigger id="edit-role" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={SUPER_ADMIN}>
                              Super admin
                            </SelectItem>
                            <SelectItem value={ORG_MANAGER}>
                              Org manager
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {role === ORG_MANAGER && props.orgs.length > 0 && (
                      <div>
                        <label
                          htmlFor="edit-org"
                          className="mb-1 block text-xs font-medium text-muted-foreground"
                        >
                          Organization
                        </label>
                        <Select
                          value={scopeId}
                          onValueChange={setScopeId}
                          disabled={submitting}
                        >
                          <SelectTrigger id="edit-org" className="w-full">
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
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Resend invitation (UX5b / #184) — only when status is "Invited".
                  Positioned ABOVE the destructive Revoke action so the
                  constructive option is reached first. */}
              {showResend && (
                <div className="border-t border-border pt-4">
                  {resendFeedback?.kind === "success" && (
                    <div className="mb-3">
                      <Banner tone="success" title="Invitation resent">
                        Invitation resent to {t.email}.
                      </Banner>
                    </div>
                  )}
                  {resendFeedback?.kind === "rate-limit" && (
                    <div className="mb-3">
                      <Banner tone="warn" title="Rate limited">
                        Too many invitations sent recently. Try again in a
                        few minutes.
                      </Banner>
                    </div>
                  )}
                  {resendFeedback?.kind === "error" && (
                    <div className="mb-3">
                      <Banner
                        tone="destructive"
                        title="Could not resend invitation"
                      >
                        {resendFeedback.message}
                      </Banner>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={resending}
                    className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3.5 text-[13px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {resending ? "Sending…" : "Resend invitation"}
                  </button>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Re-issues the magic-link email. The previous link is
                    superseded.
                  </p>
                </div>
              )}

              {/* Revoke */}
              {props.canRevoke && (
                <div className="border-t border-border pt-4">
                  <button
                    type="button"
                    onClick={() => setConfirmOpen(true)}
                    className="inline-flex h-8 items-center rounded-md border border-destructive bg-destructive-muted px-3.5 text-[13px] font-medium text-destructive-fg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Revoke access
                  </button>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Removes this user&apos;s role. The auth account is preserved
                    and can be re-invited.
                  </p>
                </div>
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
                  {submitting ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Revoke access?"
        description={`Remove ${t.email}'s access to MBE. They can be re-invited later.`}
        confirmLabel="Revoke access"
        tone="destructive"
        onConfirm={handleRevoke}
      />
    </>
  );
}
