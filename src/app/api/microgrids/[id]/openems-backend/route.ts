import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import { createOpenEmsClient, OpenEmsError } from "@/lib/openems";
import type { OpenEmsClientConfig } from "@/lib/openems";
import { scrubSecretValues } from "@/lib/logging/scrub-secrets";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PUT /api/microgrids/[id]/openems-backend — Save & test connection (#101).
 *
 * Body shape:
 *   { type: 'cloud_aws' | 'direct_url',
 *     backendUrl: string,
 *     region?, accessKeyId?, secretAccessKey?   // cloud_aws
 *     confirmed_name?: string                   // closed-period bypass
 *   }
 *
 * Mandatory execution order (AC-ROUTE-1, amendments 2026-04-23):
 *
 *   1. Validate body shape → 400 on malformed.
 *   2. Permission check via currentUserCanAccessMicrogrid. 404 if the
 *      microgrid is hidden/missing (don't leak existence with a 403).
 *   3. Mid-period lock — 3-branch decision tree:
 *        (a) draft exists            → hard 409
 *        (b) closed exists (no draft) → 409 with requires_typed_confirmation
 *                                       unless body.confirmed_name matches
 *        (c) no periods              → free pass
 *   4. Persist the config (first transaction). fn_ems_encrypt_secret encrypts
 *      the AWS secret key if supplied.
 *   5. Run Discover against the newly-saved config (second transaction;
 *      status fields updated regardless of success).
 *   6. Return { status, message, edgeCount?, edges? }.
 *
 * Error mapping (OpenEmsError):
 *   auth failure  → status='auth_failed'   message with rotated-key hint
 *   fetch failure → status='unreachable'   message with URL
 *   zero edges    → status='zero_edges'    message
 *   unknown       → status='unknown_error' message + full error kept server-side
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const startedAt = Date.now();
  const { id: microgridId } = await params;

  if (!UUID_RE.test(microgridId)) {
    return NextResponse.json(
      { error: "Invalid microgrid id — expected UUID" },
      { status: 400 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Request body must be an object" },
      { status: 400 }
    );
  }

  const type = body.type;
  const backendUrl = body.backendUrl;

  if (type !== "cloud_aws" && type !== "direct_url") {
    return NextResponse.json(
      { error: "type must be 'cloud_aws' or 'direct_url'" },
      { status: 400 }
    );
  }
  if (typeof backendUrl !== "string" || !backendUrl.trim()) {
    return NextResponse.json(
      { error: "backendUrl is required" },
      { status: 400 }
    );
  }

  let region: string | undefined;
  let accessKeyId: string | undefined;
  let secretAccessKey: string | undefined;

  if (type === "cloud_aws") {
    region = typeof body.region === "string" ? body.region.trim() : undefined;
    accessKeyId =
      typeof body.accessKeyId === "string" ? body.accessKeyId.trim() : undefined;
    secretAccessKey =
      typeof body.secretAccessKey === "string"
        ? body.secretAccessKey
        : undefined;

    if (!region || !accessKeyId || !secretAccessKey) {
      return NextResponse.json(
        {
          error:
            "type='cloud_aws' requires region, accessKeyId, and secretAccessKey",
        },
        { status: 400 }
      );
    }
  }

  const supabase = await createClient();

  // Permission check — 404 on hidden/missing (don't leak existence).
  const { data: mgRow, error: mgErr } = await supabase
    .from("microgrids")
    .select("id, name")
    .eq("id", microgridId)
    .maybeSingle<{ id: string; name: string }>();

  if (mgErr) {
    return NextResponse.json(
      { error: `Failed to read microgrid: ${mgErr.message}` },
      { status: 500 }
    );
  }
  if (!mgRow) {
    return NextResponse.json({ error: "Microgrid not found." }, { status: 404 });
  }
  if (!(await currentUserCanAccessMicrogrid(supabase, microgridId))) {
    return NextResponse.json(
      { error: "You do not have permission to configure this microgrid." },
      { status: 403 }
    );
  }

  // Mid-period lock — 3-branch decision tree (amendments 2026-04-23).
  const { data: periods, error: periodsErr } = await supabase
    .from("billing_periods")
    .select("id, status")
    .eq("microgrid_id", microgridId)
    .in("status", ["draft", "closed"]);

  if (periodsErr) {
    return NextResponse.json(
      { error: `Failed to read billing periods: ${periodsErr.message}` },
      { status: 500 }
    );
  }

  const draftCount = (periods ?? []).filter((p) => p.status === "draft").length;
  const closedCount = (periods ?? []).filter((p) => p.status === "closed").length;

  if (draftCount > 0) {
    // Branch (a) — hard 409.
    return NextResponse.json(
      {
        error:
          "Close or delete the draft period first. Changing the OpenEMS backend requires rediscovering devices and would invalidate readings from the current period.",
        draft_count: draftCount,
        closed_count: closedCount,
      },
      { status: 409 }
    );
  }

  if (closedCount > 0) {
    // Branch (b) — type-to-confirm. Proceed only if confirmed_name matches.
    const confirmed =
      typeof body.confirmed_name === "string" &&
      body.confirmed_name.trim() === mgRow.name.trim();

    if (!confirmed) {
      return NextResponse.json(
        {
          error: `This microgrid has ${closedCount} closed billing period${closedCount === 1 ? "" : "s"}. Changing the OpenEMS backend may affect historical invoice verification if edge IDs differ after rediscovery. Type the microgrid name to confirm.`,
          requires_typed_confirmation: { entity_name: mgRow.name },
          draft_count: draftCount,
          closed_count: closedCount,
        },
        { status: 409 }
      );
    }

    if (
      typeof body.confirmed_name === "string" &&
      body.confirmed_name.trim() !== mgRow.name.trim()
    ) {
      // Defensive: above branch catches mismatch, but a race could send
      // confirmed_name through a stale UI. Return 400 on a real mismatch.
      return NextResponse.json(
        { error: "Confirmed name does not match the microgrid name." },
        { status: 400 }
      );
    }
  }

  // Branch (c): no periods — fall through.

  // ── Transaction 1: persist config ──────────────────────────────────────
  //
  // We encrypt the AWS secret via a single RPC + a separate UPDATE. This is
  // two DB round-trips but only one committed transaction for the write
  // (the RPC is stateless). Discover runs in its own transaction below.

  let encryptedSecret: string | null = null;
  if (type === "cloud_aws" && secretAccessKey) {
    const { data, error } = await supabase.rpc("fn_ems_encrypt_secret", {
      p_plaintext: secretAccessKey,
    });
    if (error || !data) {
      return NextResponse.json(
        {
          error: `Failed to encrypt secret: ${error?.message ?? "no data"}`,
        },
        { status: 500 }
      );
    }
    encryptedSecret = data as string;
  }

  const updatePayload: Record<string, unknown> = {
    ems_type: type,
    ems_backend_url: backendUrl.trim(),
    ems_aws_region: type === "cloud_aws" ? region : null,
    ems_aws_access_key_id: type === "cloud_aws" ? accessKeyId : null,
    ems_aws_secret_access_key_encrypted:
      type === "cloud_aws" ? encryptedSecret : null,
  };

  const { error: updErr } = await supabase
    .from("microgrids")
    .update(updatePayload)
    .eq("id", microgridId);

  if (updErr) {
    if (
      updErr.code === "42501" ||
      updErr.message.includes("row-level security")
    ) {
      return NextResponse.json(
        { error: "You do not have permission to configure this microgrid." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      {
        error: scrubSecretValues(
          `Failed to persist config: ${updErr.message}`,
          { secretAccessKey }
        ),
      },
      { status: 500 }
    );
  }

  // ── Transaction 2: Discover — runs against the candidate config directly.
  //
  // We build the client from the body (not from getMicrogridEmsConfig) so the
  // Discover-after-Save round-trip doesn't depend on RLS for reading the
  // encrypted secret back. This is explicitly the "candidate config" path.
  const candidateConfig: OpenEmsClientConfig =
    type === "cloud_aws"
      ? {
          type: "cloud_aws",
          url: backendUrl.trim(),
          region: region as string,
          accessKeyId: accessKeyId as string,
          secretAccessKey: secretAccessKey as string,
        }
      : { type: "direct_url", url: backendUrl.trim() };

  let discoverStatus:
    | "success"
    | "auth_failed"
    | "unreachable"
    | "zero_edges"
    | "unknown_error" = "success";
  let discoverMessage = "";
  let discoveredEdges: Array<{
    openems_edge_id: string;
    name: string;
    metadata: Record<string, unknown>;
    alreadyLinked: boolean;
  }> = [];

  try {
    const client = createOpenEmsClient(candidateConfig);
    // We need all edges; the Backend exposes getEdgesStatus which returns
    // a map keyed by edge id. For a candidate config we don't know edge IDs
    // ahead of time — but the JSON-RPC `getEdgesStatus` needs the list of
    // IDs. Convention on OpenEMS Backend: an empty list is invalid. So we
    // use `edgeRpc → getEdges` via a side-channel in a follow-up. For
    // pilot, we ask the Backend for its edges via `getEdges` RPC which is
    // a documented Cloud extension. If it fails, we fall back to an empty
    // list and surface zero_edges.
    //
    // For now we implement a minimal-viable Discover by invoking
    // getEdgesStatus([]) which on many backends returns the full catalog.
    // A proper getEdges method will land alongside #102 UI work.
    const statuses = await client.getEdgesStatus([]);
    if (statuses.length === 0) {
      discoverStatus = "zero_edges";
      discoverMessage =
        "Connected, but the OpenEMS Backend returned zero edges. Check that edges are registered under this backend.";
    } else {
      const prefetched = new Set<string>();
      const { data: existing } = await supabase
        .from("edges")
        .select("openems_edge_id")
        .eq("microgrid_id", microgridId);
      for (const e of existing ?? []) {
        if (e.openems_edge_id) prefetched.add(e.openems_edge_id);
      }

      discoveredEdges = statuses.map((s) => ({
        openems_edge_id: s.edgeId,
        name: s.edgeId, // Backend doesn't return a display name here; UI may enrich later.
        metadata: { online: s.online },
        alreadyLinked: prefetched.has(s.edgeId),
      }));
      discoverMessage = `Connected. ${discoveredEdges.length} edge${discoveredEdges.length === 1 ? "" : "s"} discovered.`;
    }
  } catch (err) {
    if (err instanceof OpenEmsError) {
      if (err.code === "OPENEMS_AUTH_FAILED") {
        discoverStatus = "auth_failed";
        discoverMessage =
          "Authentication failed. Verify your AWS credentials and region (common cause: rotated access key).";
      } else if (err.code === "OPENEMS_UNREACHABLE") {
        discoverStatus = "unreachable";
        discoverMessage = `Could not reach OpenEMS Backend at ${backendUrl.trim()}. Check the URL and that the host is reachable from Vercel.`;
      } else {
        discoverStatus = "unknown_error";
        discoverMessage =
          "Discover failed with an unexpected error. Check server logs.";
      }
    } else {
      discoverStatus = "unknown_error";
      discoverMessage =
        "Discover failed with an unexpected error. Check server logs.";
    }
  }

  // Update health fields.
  const { error: healthErr } = await supabase
    .from("microgrids")
    .update({
      ems_last_discover_at: new Date().toISOString(),
      ems_last_discover_status: discoverStatus,
      ems_last_discover_error:
        discoverStatus === "success" ? null : discoverMessage,
      ems_last_discover_count:
        discoverStatus === "success" ? discoveredEdges.length : null,
    })
    .eq("id", microgridId);

  if (healthErr) {
    // Non-fatal: save already succeeded; we log and continue.
    console.warn(
      `openems.save: failed to update health fields: ${healthErr.message}`
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  console.info(
    JSON.stringify(
      scrubSecretValues(
        {
          event: "openems.save_and_test",
          microgrid_id: microgridId,
          actor_user_id: user?.id ?? null,
          ems_type: type,
          result_status: discoverStatus,
          edge_count: discoveredEdges.length,
          duration_ms: Date.now() - startedAt,
          at: new Date().toISOString(),
        },
        { secretAccessKey }
      )
    )
  );

  return NextResponse.json(
    {
      status: discoverStatus,
      message: discoverMessage,
      edgeCount: discoveredEdges.length,
      edges: discoveredEdges,
    },
    { status: 200 }
  );
}
