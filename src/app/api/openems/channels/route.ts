import { NextRequest, NextResponse } from "next/server";
import { getOpenEmsClient, OpenEmsError } from "@/lib/openems";

type ChannelsRequestBody = {
  edgeIds: string[];
  channels: string[];
};

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

  try {
    const client = getOpenEmsClient();
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
