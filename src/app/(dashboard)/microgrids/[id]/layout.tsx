import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Microgrid } from "@/lib/types/database";
import { TabNav } from "./tab-nav";

export default async function MicrogridLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("microgrids")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    notFound();
  }

  const microgrid = data as Microgrid;

  return (
    <div>
      <div className="mb-6">
        <a
          href="/microgrids"
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          &larr; Back to Microgrids
        </a>
        <h1 className="mt-2 text-2xl font-semibold text-gray-900">
          {microgrid.name}
        </h1>
        {microgrid.location && (
          <p className="mt-1 text-sm text-gray-500">{microgrid.location}</p>
        )}
      </div>
      <TabNav microgridId={id} />
      <div className="mt-6">{children}</div>
    </div>
  );
}
