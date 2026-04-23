import { createClient } from "@/lib/supabase/server";
import type { Microgrid } from "@/lib/types/database";

type MicrogridWithTenantCount = Microgrid & {
  tenant_count: number;
};

export default async function MicrogridsPage() {
  const supabase = await createClient();

  const { data: microgrids, error } = await supabase
    .from("microgrids")
    .select("*")
    .returns<Microgrid[]>();

  if (error) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading microgrids: {error.message}
      </div>
    );
  }

  if (!microgrids || microgrids.length === 0) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-semibold text-foreground">
          Microgrids
        </h1>
        <div className="rounded-md border border-border bg-card p-8 text-center text-muted-foreground">
          No microgrids found. Microgrids are configured by your system
          administrator.
        </div>
      </div>
    );
  }

  const microgridsWithCounts: MicrogridWithTenantCount[] = [];
  for (const mg of microgrids) {
    const { count } = await supabase
      .from("tenants")
      .select("*", { count: "exact", head: true })
      .eq("microgrid_id", mg.id);

    microgridsWithCounts.push({
      ...mg,
      tenant_count: count ?? 0,
    });
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-foreground">Microgrids</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {microgridsWithCounts.map((mg) => (
          <a
            key={mg.id}
            href={`/microgrids/${mg.id}`}
            className="block rounded-lg border border-border bg-card p-6 transition-colors hover:border-border hover:bg-muted"
          >
            <h2 className="font-medium text-foreground">{mg.name}</h2>
            {mg.location && (
              <p className="mt-1 text-sm text-muted-foreground">{mg.location}</p>
            )}
            <div className="mt-3 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {mg.tenant_count} tenant{mg.tenant_count !== 1 ? "s" : ""}
              </span>
              <span className="text-muted-foreground">{mg.currency}</span>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
