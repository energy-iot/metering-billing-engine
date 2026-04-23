"use client";

/**
 * EdgeDetailConfigureButton — renders the "Configure…" button in the edge detail
 * header and manages the EdgeFormModal open/close state.
 *
 * Extracted as a thin client component so the EdgeDetailPage server component
 * can remain async (server-side data fetching pattern).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Edge } from "@/lib/types/domain";
import { EdgeFormModal } from "@/components/forms/EdgeForm";

export function EdgeDetailConfigureButton({ edge }: { edge: Edge }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="ml-auto text-xs font-medium text-primary hover:underline"
      >
        Configure…
      </button>
      <EdgeFormModal
        edge={edge}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) router.refresh();
        }}
      />
    </>
  );
}
