import { redirect } from "next/navigation";

// Legacy redirect stub (D2 / #53). `/tenants` was the old flat-tab route;
// the new IA places households under Setup. Kept so bookmarks + external
// links don't break.
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/microgrids/${id}/setup/households`);
}
