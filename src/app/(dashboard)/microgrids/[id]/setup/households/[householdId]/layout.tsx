// Passthrough layout — HierarchyNav is owned by the leaf page (household detail page).
// This file must exist to satisfy Next.js layout conventions but renders children directly.
export default function HouseholdDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
