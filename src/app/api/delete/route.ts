// POST /api/delete — Remove a generation from history

import { NextRequest, NextResponse } from "next/server";
import { deleteHistoryItem } from "@/lib/history";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const { id } = await request.json();

    if (!id) {
      return NextResponse.json({ error: "ID required" }, { status: 400 });
    }

    const filename = await deleteHistoryItem(id);

    return NextResponse.json({ success: true, deletedFile: filename });
  } catch (error) {
    console.error("Delete error:", error);
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
