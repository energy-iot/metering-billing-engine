import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { currentUserCanAccessOrg } from "@/lib/auth/access";

/**
 * POST /api/communities/[id]/invoice-logo — Upload an invoice-logo image (#204 / PDF2).
 *
 * Permission-FIRST execution order. We read the community row + verify the
 * caller can edit BEFORE reading the multipart body — this guards against an
 * unauthorised caller streaming a megabyte of bytes into our function. The
 * storage write goes via `createServiceClient()` (bypasses RLS), so this
 * route's permission gate IS the only authorisation barrier; the
 * `storage.objects` RLS policies in 00033 are defense-in-depth for the
 * operator-preview SELECT path.
 *
 * SVG XSS scope-out (#204 R5): SVGs are accepted, NOT sanitised. They are
 * rasterised by `@react-pdf/renderer` (no script execution) and previewed via
 * the operator's authenticated browser session. **Implementer constraint:
 * never wire a public, unauthenticated endpoint that returns the raw bytes
 * from `invoice-logos`** — that's the only place XSS would reactivate.
 *
 * Server-side defense-in-depth on size: 1 MB cap (UI enforces 500 KB tighter
 * client-side). The bucket also caps at 1 MiB in 00033.
 *
 * Path schema: `{community.id}/{Date.now()}-{crypto.randomUUID()}.{ext}`.
 * `crypto.randomUUID()` is cryptographically random; collision is effectively
 * impossible. `Date.now()` keeps file lists chronologically ordered when
 * listed by the operator UI.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB server-side cap.

const ALLOWED_MIME = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/svg+xml",
]);

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
};

const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes for the thumbnail handoff.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: communityId } = await params;

  // (1) UUID parse.
  if (!UUID_RE.test(communityId)) {
    return NextResponse.json(
      { error: "Invalid community id — expected UUID." },
      { status: 400 },
    );
  }

  const supabase = await createClient();

  // (2) Row read — RLS-hidden / missing → 404. Don't leak existence via 403.
  const { data: community, error: commErr } = await supabase
    .from("communities")
    .select("id, org_id")
    .eq("id", communityId)
    .maybeSingle<{ id: string; org_id: string }>();

  if (commErr) {
    return NextResponse.json(
      { error: `Failed to read community: ${commErr.message}` },
      { status: 500 },
    );
  }
  if (!community) {
    return NextResponse.json(
      { error: "Community not found." },
      { status: 404 },
    );
  }

  // (3) Permission BEFORE body read.
  if (!(await currentUserCanAccessOrg(supabase, community.org_id))) {
    return NextResponse.json(
      {
        error:
          "You do not have permission to upload a logo for this community.",
      },
      { status: 403 },
    );
  }

  // (4) Multipart body parse — Next.js 15 native FormData.
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart form body." },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json(
      { error: "Missing `file` field in multipart form." },
      { status: 400 },
    );
  }

  // file is a Web `File` instance.
  const mime = file.type;
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json(
      {
        error:
          "Unsupported file type. Allowed: image/png, image/jpeg, image/svg+xml.",
      },
      { status: 400 },
    );
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json(
      { error: "File too large. Maximum size is 1 MB." },
      { status: 400 },
    );
  }

  // (5) Build the storage path: relative to the bucket, no leading slash.
  const ext = EXT_BY_MIME[mime] ?? "bin";
  const storagePath = `${community.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

  // (6) Service-role upload (bypasses RLS — the route IS the gate).
  const service = createServiceClient();
  const fileBytes = await file.arrayBuffer();

  const uploadResult = await service.storage
    .from("invoice-logos")
    .upload(storagePath, fileBytes, {
      contentType: mime,
      upsert: false,
    });

  if (uploadResult.error) {
    return NextResponse.json(
      {
        error: `Failed to upload logo: ${uploadResult.error.message}`,
      },
      { status: 500 },
    );
  }

  // (7) Generate a 5-minute signed URL so the form can swap the thumbnail
  // immediately without a second round-trip.
  const signedResult = await service.storage
    .from("invoice-logos")
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  const signedThumbnailUrl = signedResult.data?.signedUrl ?? "";

  return NextResponse.json(
    {
      logo_storage_path: storagePath,
      signed_thumbnail_url: signedThumbnailUrl,
    },
    { status: 200 },
  );
}
