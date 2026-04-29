import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  currentUserCanAccessCommunity,
  currentUserCanAccessOrg,
} from "@/lib/auth/access";
import type { InvoiceConfig } from "@/lib/invoices/config-schema";
import { InvoiceShell } from "./invoice-shell";

/**
 * /communities/[id]/invoice — Invoice configuration tab (#204 / PDF2).
 *
 * Defense-in-depth pattern (matches the layout's hidden-tab behaviour with a
 * 404):
 *   - 404 if the user can't read the community (RLS-hidden / non-existent).
 *   - 404 if the user can read but not edit (read-but-not-edit user). Don't
 *     render an empty form or a "you can't edit" message — match the
 *     hidden-tab semantics with a 404.
 *
 * Loads the persisted `invoice_config` JSONB + `invoice_prefix` column +
 * generates a 5-minute signed thumbnail URL when a logo is set, and passes
 * everything to `<InvoiceShell>` (client). The signed URL is generated via
 * the service-role client because the bucket is private and the operator's
 * browser session can't SELECT directly without a signed URL.
 */

const SIGNED_THUMBNAIL_TTL_SECONDS = 300;

export default async function InvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // Read gate (404 if hidden — don't leak existence).
  const canAccess = await currentUserCanAccessCommunity(supabase, id);
  if (!canAccess) notFound();

  const { data: community, error: commErr } = await supabase
    .from("communities")
    .select("id, org_id, name, invoice_config, invoice_prefix")
    .eq("id", id)
    .maybeSingle<{
      id: string;
      org_id: string;
      name: string;
      invoice_config: unknown;
      invoice_prefix: string | null;
    }>();

  if (commErr || !community) notFound();

  // Edit gate (404 for read-but-not-edit users, matching the hidden-tab
  // semantics). A bookmarked URL still 404s for cross-org.
  const canEdit = await currentUserCanAccessOrg(supabase, community.org_id);
  if (!canEdit) notFound();

  // Normalize invoice_config — empty `{}` is the column default.
  const persistedConfig: InvoiceConfig =
    community.invoice_config &&
    typeof community.invoice_config === "object" &&
    !Array.isArray(community.invoice_config)
      ? (community.invoice_config as InvoiceConfig)
      : {};

  // Generate a 5-minute signed thumbnail URL when a logo is persisted.
  let signedThumbnailUrl: string | null = null;
  const persistedLogoPath =
    persistedConfig.branding?.logo_storage_path ?? null;
  if (persistedLogoPath) {
    try {
      const service = createServiceClient();
      const { data: signed } = await service.storage
        .from("invoice-logos")
        .createSignedUrl(persistedLogoPath, SIGNED_THUMBNAIL_TTL_SECONDS);
      signedThumbnailUrl = signed?.signedUrl ?? null;
    } catch {
      // Signed-URL generation failure is non-fatal — the form falls back to
      // showing the path text and the operator can re-upload if needed.
      signedThumbnailUrl = null;
    }
  }

  return (
    <div className="space-y-4">
      <InvoiceShell
        communityId={community.id}
        communityName={community.name}
        initialConfig={persistedConfig}
        initialPrefix={community.invoice_prefix}
        initialSignedThumbnailUrl={signedThumbnailUrl}
      />
    </div>
  );
}
