import { SetupSubNav } from "./setup-subnav";

// Setup sub-layout (D2 / #53).
// Wraps the three Setup sub-routes with a shared tablist sub-nav.
export default async function SetupLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Setup
        </p>
        <h2 className="text-xl font-semibold text-foreground">Configure this microgrid</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure-once area. Return during onboarding or when hardware changes.
        </p>
      </div>

      <SetupSubNav microgridId={id} />

      <div>{children}</div>
    </div>
  );
}
