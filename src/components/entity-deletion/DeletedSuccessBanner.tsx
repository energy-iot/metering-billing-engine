/**
 * DeletedSuccessBanner — renders a one-shot success banner on the parent
 * page of a just-deleted entity (#89 / AC-UI-7).
 *
 * Reads `?deleted=<kind>&name=<name>` from the incoming server searchParams.
 * No auto-dismiss logic — navigation or reload clears the query param.
 * Server component: no hydration cost when the params are absent.
 *
 * Usage:
 *   // In a server page component:
 *   export default async function Page({ searchParams }) {
 *     const sp = await searchParams;
 *     return (
 *       <>
 *         <DeletedSuccessBanner searchParams={sp} />
 *         ...
 *       </>
 *     );
 *   }
 */

import * as React from "react";
import { Banner } from "@/components/ui/banner";

type Kind = "organization" | "community" | "microgrid" | "edge";

const KIND_LABEL: Record<Kind, string> = {
  organization: "Organization",
  community: "Community",
  microgrid: "Microgrid",
  edge: "Edge",
};

function isKind(v: unknown): v is Kind {
  return (
    v === "organization" ||
    v === "community" ||
    v === "microgrid" ||
    v === "edge"
  );
}

export interface DeletedSuccessBannerProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export function DeletedSuccessBanner({ searchParams }: DeletedSuccessBannerProps) {
  const rawKind = searchParams?.deleted;
  const rawName = searchParams?.name;

  const kindStr = Array.isArray(rawKind) ? rawKind[0] : rawKind;
  const nameStr = Array.isArray(rawName) ? rawName[0] : rawName;

  if (!isKind(kindStr) || !nameStr) return null;

  return (
    <Banner tone="success" title={`${KIND_LABEL[kindStr]} deleted`}>
      <strong>{nameStr}</strong> has been permanently deleted.
    </Banner>
  );
}
