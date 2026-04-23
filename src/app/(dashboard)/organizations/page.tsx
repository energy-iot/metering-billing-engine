import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { currentUserIsSuperAdmin } from "@/lib/auth/access";
import { AddEntityButton } from "@/components/forms/AddEntityButton";
import type { Organization } from "@/lib/types/domain";

/**
 * /organizations — organization listing page (#76).
 *
 * Visibility (server-enforced via RLS on the organizations table):
 *   - super_admin: sees all organizations
 *   - org_manager: sees only their own org (RLS filters the SELECT)
 *
 * "+ Add Organization" button renders only for super_admin. Empty-state copy
 * diverges: super_admin gets a CTA; org_manager with zero visible orgs gets a
 * pointer to contact their administrator.
 */
export default async function OrganizationsPage() {
  const supabase = await createClient();

  const [isSuperAdmin, orgsResult] = await Promise.all([
    currentUserIsSuperAdmin(supabase),
    supabase
      .from("organizations")
      .select("*")
      .order("name")
      .returns<Organization[]>(),
  ]);

  const { data: organizations, error } = orgsResult;

  if (error) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading organizations: {error.message}
      </div>
    );
  }

  const orgs = organizations ?? [];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">
          Organizations
        </h1>
        {isSuperAdmin && orgs.length > 0 && (
          <AddEntityButton entity="organization" />
        )}
      </div>

      {orgs.length === 0 ? (
        <div className="rounded-md border border-border bg-card p-8 text-center">
          {isSuperAdmin ? (
            <>
              <p className="mb-4 text-muted-foreground">
                No organizations yet.
              </p>
              <AddEntityButton
                entity="organization"
                label="+ Add the first Organization"
              />
            </>
          ) : (
            <p className="text-muted-foreground">
              No organizations visible. Contact your administrator.
            </p>
          )}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {orgs.map((org) => {
            const locationParts = [org.address_city, org.address_country].filter(
              Boolean
            );
            const locationLabel =
              locationParts.length > 0 ? locationParts.join(", ") : null;

            return (
              <Link
                key={org.id}
                href={`/organizations/${org.id}`}
                className="block rounded-lg border border-border bg-card p-6 transition-colors hover:border-border hover:bg-muted"
              >
                <h2 className="font-medium text-foreground">{org.name}</h2>
                {locationLabel && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {locationLabel}
                  </p>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
