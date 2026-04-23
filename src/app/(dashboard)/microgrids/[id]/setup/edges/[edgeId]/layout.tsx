// Passthrough layout — HierarchyNav is owned by the leaf page (edge detail page).
// This file must exist to satisfy Next.js layout conventions but renders children directly.
export default function EdgeDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
