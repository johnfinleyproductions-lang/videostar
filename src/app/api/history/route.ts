// GET /api/history — Return generation history from local JSON

import { NextRequest, NextResponse } from "next/server";
import { readHistory } from "@/lib/history";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const offset = parseInt(searchParams.get("offset") || "0");
    const limit = parseInt(searchParams.get("limit") || "20");
    const search = searchParams.get("search") || "";

    let items = await readHistory();

    // Filter by search query
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(
        (item) =>
          item.prompt?.toLowerCase().includes(q) ||
          item.resolution?.toLowerCase().includes(q)
      );
    }

    const total = items.length;
    const page = items.slice(offset, offset + limit);

    return NextResponse.json({
      items: page,
      total,
      hasMore: offset + limit < total,
    });
  } catch (error) {
    console.error("History error:", error);
    return NextResponse.json({ items: [], total: 0, hasMore: false });
  }
}
