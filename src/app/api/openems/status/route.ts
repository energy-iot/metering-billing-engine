import { NextRequest, NextResponse } from "next/server";
import { getOpenEmsClient, OpenEmsError } from "@/lib/openems";

export async function GET(request: NextRequest) {
  const edgeIdsParam = request.nextUrl.searchParams.get("edgeIds");

  if (!edgeIdsParam) {
    return NextResponse.json(
      { error: "Missing required query parameter: edgeIds" },
      { status: 400 }
    );
  }

  const edgeIds = edgeIdsParam
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (edgeIds.length === 0) {
    return NextResponse.json(
      { error: "edgeIds parameter must contain at least one edge ID" },
      { status: 400 }
    );
  }

  try {
    const client = getOpenEmsClient();
    const edges = await client.getEdgesStatus(edgeIds);
    return NextResponse.json({ edges });
  } catch (err) {
    if (err instanceof OpenEmsError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode }
      );
    }
    return NextResponse.json(
      { error: "Unexpected error fetching edge status" },
      { status: 500 }
    );
  }
}
