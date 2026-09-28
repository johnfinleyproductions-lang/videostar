// GET /api/output?filename=...&subfolder=...[&worker=<name>] — Proxy ComfyUI
// output files from the fleet worker that rendered them (worker omitted =
// the default worker — every pre-fleet URL keeps working unchanged; the
// status route only appends &worker= for NON-default workers).
// GET /api/output?remotion=<remoteJobId>[&variant=preview] — Proxy MG-TYPE
// files straight from the think render service (:3070/files/<jobId>).
// GET /api/output?revoice=<jobId>[&variant=audio] — Stream a finished REVOICE
// deliverable off local disk (Range-capable; &variant=audio = the keepAudio
// .wav companion).

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { getOutputFile } from "@/lib/comfyui-client";
import { getWorkerComfyBase } from "@/lib/fleet";
import { getLtxDesktopOutputFile } from "@/lib/ltx-desktop-client";
import {
  fetchRemotionFile,
  RemotionServiceUnreachableError,
} from "@/lib/remotion-client";
import { isRevoiceJobId, revoiceOutputPath } from "@/lib/revoice-client";

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

    // ------------------------------------------------------------------
    // REVOICE passthrough (streams the finished file off local disk)
    // ------------------------------------------------------------------
    // MUST be an API route, not a static /outputs/... path: `next start` scans
    // public/ only at BOOT, so a file a job writes while the server is running
    // 404s until the next restart (measured live 2026-09-26). Streaming here
    // also gives real Range support so a browser can seek the mp4.
    // &variant=audio serves the keepAudio .wav companion.
    const revoiceJobId = searchParams.get("revoice");
    if (revoiceJobId) {
      if (!isRevoiceJobId(revoiceJobId)) {
        return NextResponse.json(
          { error: "Invalid REVOICE job id" },
          { status: 400 },
        );
      }
      const variant =
        searchParams.get("variant") === "audio" ? "audio" : "primary";
      const filePath = revoiceOutputPath(revoiceJobId, variant);

      let size: number;
      try {
        size = (await stat(filePath)).size;
      } catch {
        return NextResponse.json(
          {
            error:
              variant === "audio"
                ? "No standalone audio for this job (pass keepAudio on the request to emit one)"
                : "REVOICE output not found",
          },
          { status: 404 },
        );
      }

      const contentType = variant === "audio" ? "audio/wav" : "video/mp4";
      const filename = `${revoiceJobId}${variant === "audio" ? ".wav" : ".mp4"}`;
      const rangeHeader = request.headers.get("range");
      const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);

      // Honour a byte range so <video> seeking works; anything unparseable or
      // out of bounds degrades to the full body rather than erroring.
      if (match && (match[1] || match[2])) {
        let start = match[1] ? Number(match[1]) : 0;
        let end = match[2] ? Number(match[2]) : size - 1;
        if (!match[1] && match[2]) {
          // suffix form "bytes=-500" = the LAST 500 bytes
          start = Math.max(0, size - Number(match[2]));
          end = size - 1;
        }
        if (
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          start <= end &&
          start < size
        ) {
          end = Math.min(end, size - 1);
          const stream = Readable.toWeb(
            createReadStream(filePath, { start, end }),
          ) as ReadableStream;
          return new NextResponse(stream, {
            status: 206,
            headers: {
              "Content-Type": contentType,
              "Content-Length": String(end - start + 1),
              "Content-Range": `bytes ${start}-${end}/${size}`,
              "Accept-Ranges": "bytes",
              "Content-Disposition": `inline; filename="${filename}"`,
              "Cache-Control": "public, max-age=31536000, immutable",
            },
          });
        }
      }

      const stream = Readable.toWeb(
        createReadStream(filePath),
      ) as ReadableStream;
      return new NextResponse(stream, {
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(size),
          "Accept-Ranges": "bytes",
          "Content-Disposition": `inline; filename="${filename}"`,
          // Immutable per job id — same policy as the ComfyUI files.
          "Cache-Control": "public, max-age=31536000, immutable",
        },
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

    // Fleet worker that holds the file (missing/unknown → default worker).
    const comfyBase = getWorkerComfyBase(searchParams.get("worker"));
    const comfyResponse = await getOutputFile(comfyBase, filename, subfolder);

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
