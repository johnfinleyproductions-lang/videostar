// GET /api/lanes — Machine-readable lane manifest.
//
// Lets callers (Evergreen Core cockpit, agents) enumerate the named creative
// lanes and pick one per cue, then POST /api/generate with { laneKey } (or
// POST /api/finish for FINISH-STACK). No auth, cheap static JSON.
//
// Shape: { lanes: LaneDescriptor[], defaults: { text, image } } — see
// src/lib/lanes.ts for the descriptor fields.

import { NextResponse } from "next/server";
import { DEFAULT_IMAGE_LANE, DEFAULT_TEXT_LANE, LANES } from "@/lib/lanes";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    lanes: LANES,
    defaults: {
      text: DEFAULT_TEXT_LANE,
      image: DEFAULT_IMAGE_LANE,
    },
  });
}
