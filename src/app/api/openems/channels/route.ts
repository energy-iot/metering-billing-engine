import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOpenEmsClient, OpenEmsError } from "@/lib/openems";
import { getMicrogridEmsConfig } from "@/lib/openems/config";

type ChannelsRequestBody = {
  microgridId: string;
  edgeIds: string[];
  channels: string[];
};

/**
 * POST /api/openems/channels
 *
 * Post-#101: body now includes `microgridId` — the client is built from the
 * microgrid's saved OpenEMS backend config.
 */
export async function POST(request: NextRequest) {
  let body: ChannelsRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (!body.microgridId || typeof body.microgridId !== "string") {
    return NextResponse.json(
      { error: "microgridId is required" },
      { status: 400 }
    );
  }

  if (!body.edgeIds || !Array.isArray(body.edgeIds) || body.edgeIds.length === 0) {
    return NextResponse.json(
      { error: "edgeIds must be a non-empty array" },
      { status: 400 }
    );
  }

  if (!body.channels || !Array.isArray(body.channels) || body.channels.length === 0) {
    return NextResponse.json(
      { error: "channels must be a non-empty array" },
      { status: 400 }
    );
  }

  const supabase = await createClient();

  let emsConfig;
  try {
    emsConfig = await getMicrogridEmsConfig(supabase, body.microgridId);
  } catch (err) {
    if (err instanceof OpenEmsError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode }
      );
    }
    throw err;
  }

  if (!emsConfig) {
    return NextResponse.json(
      {
        error:
          "OpenEMS Backend not configured. Configure it first on the OpenEMS Backend tab.",
      },
      { status: 409 }
    );
  }

  try {
    const client = createOpenEmsClient(emsConfig);
    const values = await client.getEdgesChannelsValues(body.edgeIds, body.channels);
    return NextResponse.json({ values });
  } catch (err) {
    if (err instanceof OpenEmsError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode }
      );
    }
    return NextResponse.json(
      { error: "Unexpected error fetching channel values" },
      { status: 500 }
    );
  }
}
