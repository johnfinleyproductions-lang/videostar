// POST /api/progress — Update progress for a generation (called from WS handler)

import { NextRequest, NextResponse } from "next/server";
import { updateHistoryItem } from "@/lib/history";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const { id, progress } = await request.json();

    if (!id || progress === undefined) {
      return NextResponse.json({ error: "id and progress required" }, { status: 400 });
    }

    await updateHistoryItem(id, { progress });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Progress update error:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
