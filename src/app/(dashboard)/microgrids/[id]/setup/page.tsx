import { redirect } from "next/navigation";

// /microgrids/[id]/setup index — redirect to the first sub-tab (Edges).
export default async function SetupIndexPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/microgrids/${id}/setup/edges`);
}
