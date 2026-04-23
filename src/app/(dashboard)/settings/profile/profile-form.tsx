"use client";

/**
 * ProfileForm — edit your own profile (UX5 / #79).
 *
 * Dirty-fields PATCH to /api/users/[id]/profile. Email is read-only
 * (change flow is Out of Scope per ticket).
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Banner } from "@/components/ui/banner";
import { cn } from "@/lib/utils";

export interface ProfileFormProps {
  userId: string;
  email: string;
  initial: {
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
  };
}

export function ProfileForm(props: ProfileFormProps) {
  const router = useRouter();

  const [firstName, setFirstName] = React.useState(props.initial.first_name ?? "");
  const [lastName, setLastName] = React.useState(props.initial.last_name ?? "");
  const [phone, setPhone] = React.useState(props.initial.phone ?? "");
  const [submitting, setSubmitting] = React.useState(false);
  const [topError, setTopError] = React.useState<string | null>(null);
  const [topSuccess, setTopSuccess] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<
    Partial<Record<string, string>>
  >({});

  function buildPatch(): Record<string, string | null> {
    const p: Record<string, string | null> = {};
    const norm = (s: string) => (s.trim() === "" ? null : s.trim());
    if (norm(firstName) !== (props.initial.first_name ?? null))
      p.first_name = norm(firstName);
    if (norm(lastName) !== (props.initial.last_name ?? null))
      p.last_name = norm(lastName);
    if (norm(phone) !== (props.initial.phone ?? null)) p.phone = norm(phone);
    return p;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTopError(null);
    setTopSuccess(null);
    setFieldErrors({});

    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      setTopSuccess("No changes to save.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/users/${props.userId}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          field?: string;
        };
        if (res.status === 422 && data.field) {
          setFieldErrors({ [data.field]: data.error ?? "Invalid." });
        } else {
          setTopError(data.error ?? "Failed to save profile.");
        }
        setSubmitting(false);
        return;
      }
      setTopSuccess("Profile saved.");
      router.refresh();
    } catch {
      setTopError("Network error. Please retry.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {topError && (
        <Banner tone="destructive" title="Could not save">
          {topError}
        </Banner>
      )}
      {topSuccess && (
        <Banner tone="success" title="Saved">
          {topSuccess}
        </Banner>
      )}

      <div>
        <label
          htmlFor="profile-email"
          className="mb-1 block text-xs font-medium text-muted-foreground"
        >
          Email
        </label>
        <Input
          id="profile-email"
          type="email"
          value={props.email}
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
            htmlFor="profile-first"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            First name
          </label>
          <Input
            id="profile-first"
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            disabled={submitting}
            aria-invalid={fieldErrors.first_name ? true : undefined}
            className={cn(fieldErrors.first_name && "border-destructive")}
          />
        </div>
        <div>
          <label
            htmlFor="profile-last"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Last name
          </label>
          <Input
            id="profile-last"
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            disabled={submitting}
          />
        </div>
      </div>

      <div>
        <label
          htmlFor="profile-phone"
          className="mb-1 block text-xs font-medium text-muted-foreground"
        >
          Phone
        </label>
        <Input
          id="profile-phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={submitting}
        />
      </div>

      <div>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex h-9 items-center rounded-md border border-primary bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
  );
}
