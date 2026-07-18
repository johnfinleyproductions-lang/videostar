// GET /api/ws?clientId=... — SSE proxy for ComfyUI WebSocket progress
// Since Next.js can't natively do WebSocket upgrades, we use SSE (Server-Sent Events)
// The frontend connects here and receives real-time progress from ComfyUI's WS

import { NextRequest } from "next/server";
import WebSocket from "ws";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get("clientId");

  if (!clientId) {
    return new Response("clientId required", { status: 400 });
  }

  const comfyWsUrl =
    process.env.COMFYUI_WS_URL || "ws://127.0.0.1:8188/ws";

  const encoder = new TextEncoder();
  let wsConnection: WebSocket | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // Connect to ComfyUI WebSocket
      wsConnection = new WebSocket(`${comfyWsUrl}?clientId=${clientId}`);

      wsConnection.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          const sseData = `data: ${JSON.stringify(msg)}\n\n`;
          controller.enqueue(encoder.encode(sseData));
        } catch {
          // Ignore non-JSON messages
        }
      });

      wsConnection.on("error", (error: Error) => {
        console.error("ComfyUI WS error:", error.message);
        const errorMsg = `data: ${JSON.stringify({
          type: "error",
          data: { message: error.message },
        })}\n\n`;
        controller.enqueue(encoder.encode(errorMsg));
      });

      wsConnection.on("close", () => {
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });

      // Send initial connected event
      const connectedMsg = `data: ${JSON.stringify({
        type: "connected",
        data: { clientId },
      })}\n\n`;
      controller.enqueue(encoder.encode(connectedMsg));
    },

    cancel() {
      if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        wsConnection.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
