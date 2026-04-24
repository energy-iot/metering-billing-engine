import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { EditEntityButton } from "@/components/forms/EditEntityButton";
import { DeleteEntityButton } from "@/components/forms/DeleteEntityButton";
import { DeletedSuccessBanner } from "@/components/entity-deletion/DeletedSuccessBanner";
import { currentUserIsSuperAdmin } from "@/lib/auth/access";
import { EmptyState } from "@/components/ui/empty-state";
import { AddEntityButton } from "@/components/forms/AddEntityButton";
import type { Organization } from "@/lib/types/domain";

/**
 * /organizations/[id] — organization detail page (#76).
 *
 * Shows the org's full address + a list of its communities. The Edit button
 * in the header is only shown to super_admin users — the PATCH endpoint
 * enforces super_admin-only authorization, so showing the button to
 * org_managers would result in a misleading 403 UX.
 */
export default async function OrganizationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : undefined;
  const supabase = await createClient();

  const [{ data: org }, { data: communities }, isSuperAdmin] = await Promise.all([
    supabase
      .from("organizations")
      .select("*")
      .eq("id", id)
      .maybeSingle<Organization>(),
    supabase
      .from("communities")
      .select("id, name, address_city, address_country")
      .eq("org_id", id)
      .order("name")
      .returns<
        Array<{
          id: string;
          name: string;
          address_city: string | null;
          address_country: string | null;
        }>
      >(),
    currentUserIsSuperAdmin(supabase),
  ]);

  if (!org) {
    notFound();
  }

  const addressLines = [
    org.address_line1,
    org.address_line2,
    [org.address_city, org.address_region].filter(Boolean).join(", "),
    [org.address_country, org.address_postal_code].filter(Boolean).join(" "),
  ]
    .map((l) => (l ?? "").trim())
    .filter(Boolean);

  return (
    <div>
      <DeletedSuccessBanner searchParams={sp} />
      <div className="mb-6 mt-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{org.name}</h1>
          {addressLines.length > 0 && (
            <address className="mt-1 text-sm not-italic text-muted-foreground">
              {addressLines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </address>
          )}
        </div>
        {isSuperAdmin && (
          <div className="flex items-center gap-2">
            <EditEntityButton entity="organization" initialValues={org} />
            <DeleteEntityButton
              entity="organization"
              id={org.id}
              name={org.name}
            />
          </div>
        )}
      </div>

      <section className="rounded-lg border border-border bg-card p-6">
        <h2 className="mb-3 text-lg font-semibold text-foreground">
          Communities
        </h2>
        {!communities || communities.length === 0 ? (
          <EmptyState
            eyebrow="Communities"
            title="Add the first community"
            body={
              <>
                A community is a site where your microgrid(s) live — a
                neighborhood, building complex, or co-op. One organization can
                have many.
              </>
            }
            cta={
              isSuperAdmin ? (
                <AddEntityButton entity="community" parentOrgId={org.id} />
              ) : undefined
            }
            footnote={
              !isSuperAdmin
                ? "Ask a super admin to add the first community."
                : undefined
            }
          />
        ) : (
          <ul className="space-y-1">
            {communities.map((c) => {
              const loc = [c.address_city, c.address_country]
                .filter(Boolean)
                .join(", ");
              return (
                <li key={c.id}>
                  <Link
                    href={`/communities/${c.id}`}
                    className="text-sm text-foreground hover:underline"
                  >
                    {c.name}
                  </Link>
                  {loc && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {loc}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
