import { redirect } from "next/navigation";

export default async function MicrogridPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/microgrids/${id}/tenants`);
}
