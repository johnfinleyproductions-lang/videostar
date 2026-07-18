// GET /api/output?filename=...&subfolder=... — Proxy ComfyUI output files
// GET /api/output?remotion=<remoteJobId>[&variant=preview] — Proxy MG-TYPE
// files straight from the think render service (:3070/files/<jobId>).

import { NextRequest, NextResponse } from "next/server";
import { getOutputFile } from "@/lib/comfyui-client";
import { getLtxDesktopOutputFile } from "@/lib/ltx-desktop-client";
import {
  fetchRemotionFile,
  RemotionServiceUnreachableError,
} from "@/lib/remotion-client";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const filename = searchParams.get("filename");
    const subfolder = searchParams.get("subfolder") || "";
    const provider = searchParams.get("provider") || "comfyui";

    // ------------------------------------------------------------------
    // Remotion MG-TYPE passthrough (streams from think, never cached here)
    // ------------------------------------------------------------------
    // The status route writes url = /api/output?remotion=<remoteJobId>
    // (+ &variant=preview for the LowerThird alpha webm). The Range header
    // is forwarded and the 200/206 + Content-* headers pass through, so
    // browser video seeking works against the remote file. ProRes .mov is
    // served as video/quicktime (a download for browsers, playable in NLEs).
    const remotionJobId = searchParams.get("remotion");
    if (remotionJobId) {
      const variant =
        searchParams.get("variant") === "preview" ? "preview" : "primary";
      let upstream: Response;
      try {
        upstream = await fetchRemotionFile(
          remotionJobId,
          variant,
          request.headers.get("range"),
        );
      } catch (error) {
        if (error instanceof RemotionServiceUnreachableError) {
          return NextResponse.json({ error: error.message }, { status: 503 });
        }
        throw error;
      }
      if (!upstream.ok && upstream.status !== 206) {
        const detail = (await upstream
          .json()
          .catch(() => ({}))) as { error?: string };
        return NextResponse.json(
          { error: detail.error ?? "Remotion file not found" },
          { status: upstream.status === 404 || upstream.status === 410 ? 404 : 502 },
        );
      }
      const headers = new Headers();
      for (const name of [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "content-disposition",
      ]) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }
      // Rendered files are immutable per jobId — same policy as ComfyUI files.
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new NextResponse(upstream.body, {
        status: upstream.status,
        headers,
      });
    }

    if (provider === "ltx-desktop") {
      const outputPath = searchParams.get("path");
      if (!outputPath) {
        return NextResponse.json({ error: "Path required" }, { status: 400 });
      }

      const output = await getLtxDesktopOutputFile(outputPath);
      const body = new Uint8Array(output.body);

      return new NextResponse(body, {
        headers: {
          "Content-Type": "video/mp4",
          "Content-Disposition": `inline; filename="${output.filename}"`,
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (!filename) {
      return NextResponse.json({ error: "Filename required" }, { status: 400 });
    }

    const comfyResponse = await getOutputFile(filename, subfolder);

    if (!comfyResponse.ok) {
      return NextResponse.json(
        { error: "File not found" },
        { status: 404 }
      );
    }

    // Fallback content-type from the extension when ComfyUI omits the header
    // — .webm (Wan-Alpha RGBA lane) must not be mislabeled as video/mp4 or
    // browsers/NLEs may refuse the alpha-carrying VP9 stream, and the MUSIC
    // lane's audio files (.mp3 default; .opus/.flac if the template's saver
    // is ever swapped) must not be served as video/mp4 or <audio> elements
    // and downstream probes misread them.
    const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    const FALLBACK_CONTENT_TYPES: Record<string, string> = {
      ".webm": "video/webm",
      ".mkv": "video/x-matroska",
      ".mp3": "audio/mpeg",
      // ComfyUI SaveAudioOpus writes Opus in an Ogg container.
      ".opus": "audio/ogg",
      ".flac": "audio/flac",
      ".wav": "audio/wav",
    };
    const fallbackContentType =
      FALLBACK_CONTENT_TYPES[extension] ?? "video/mp4";
    const contentType =
      comfyResponse.headers.get("content-type") || fallbackContentType;
    const body = await comfyResponse.arrayBuffer();

    return new NextResponse(body, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("Output proxy error:", error);
    return NextResponse.json(
      { error: "Failed to fetch output" },
      { status: 500 }
    );
  }
}
