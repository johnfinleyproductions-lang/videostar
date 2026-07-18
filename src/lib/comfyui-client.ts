// FrameForge — ComfyUI HTTP Client
// IMPORTANT: Always use 127.0.0.1, NEVER localhost (IPv6 issue on CachyOS)

const COMFYUI_URL = process.env.COMFYUI_URL || "http://127.0.0.1:8188";

interface ComfyUIPromptResponse {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

interface ComfyUIOutputFile {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyUIHistoryItem {
  outputs: Record<
    string,
    {
      /** VHS_VideoCombine legacy key for video files. */
      gifs?: ComfyUIOutputFile[];
      /** Newer VHS / native video nodes use 'videos'. */
      videos?: ComfyUIOutputFile[];
      /**
       * Image nodes — AND the core SaveVideo node: its ui.PreviewVideo
       * result serializes as {"images": [...], "animated": (True,)}, so
       * .mp4 files from SaveVideo (LTX Flash lane) arrive under this key.
       */
      images?: ComfyUIOutputFile[];
      /**
       * Core SaveAudio / SaveAudioMP3 / SaveAudioOpus (MUSIC lane): their
       * SavedAudios ui result serializes as {"audio": [...]} — verified in
       * the live box's comfy_api/latest/_ui.py (SavedAudios.as_dict and
       * PreviewAudio.as_dict both key on "audio").
       */
      audio?: ComfyUIOutputFile[];
    }
  >;
  status?: {
    status_str: string;
    completed: boolean;
    messages?: unknown[];
  };
}

/**
 * Turn a ComfyUI /prompt 400 body into a readable message, surfacing
 * node_errors (per-node validation failures) when present.
 */
function formatPromptError(status: number, rawBody: string): string {
  let detail = rawBody;
  try {
    const parsed = JSON.parse(rawBody) as {
      error?: { message?: string; details?: string };
      node_errors?: Record<
        string,
        { errors?: Array<{ message?: string; details?: string }> }
      >;
    };
    const parts: string[] = [];
    if (parsed?.error?.message) {
      parts.push(
        parsed.error.details
          ? `${parsed.error.message} (${parsed.error.details})`
          : parsed.error.message,
      );
    }
    if (parsed?.node_errors && typeof parsed.node_errors === "object") {
      for (const [nodeId, nodeError] of Object.entries(parsed.node_errors)) {
        const errors = nodeError?.errors;
        if (Array.isArray(errors)) {
          for (const err of errors) {
            const msg = err?.message ?? JSON.stringify(err);
            parts.push(
              err?.details
                ? `node ${nodeId}: ${msg} (${err.details})`
                : `node ${nodeId}: ${msg}`,
            );
          }
        } else {
          parts.push(`node ${nodeId}: ${JSON.stringify(nodeError)}`);
        }
      }
    }
    if (parts.length > 0) detail = parts.join("; ");
  } catch {
    // Non-JSON body — fall through with the raw text.
  }
  return `ComfyUI queue failed (${status}): ${detail}`;
}

export async function queuePrompt(
  workflow: Record<string, unknown>,
  clientId: string
): Promise<ComfyUIPromptResponse> {
  const res = await fetch(`${COMFYUI_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: workflow,
      client_id: clientId,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(formatPromptError(res.status, text));
  }

  return res.json();
}

export async function getHistory(
  promptId: string
): Promise<ComfyUIHistoryItem | null> {
  const res = await fetch(`${COMFYUI_URL}/history/${promptId}`);
  if (!res.ok) return null;

  const data = await res.json();
  // Completion signal: the prompt_id KEY exists in the history map.
  return data[promptId] || null;
}

export async function getOutputFile(
  filename: string,
  subfolder: string = "",
  type: string = "output"
): Promise<Response> {
  const params = new URLSearchParams({ filename, subfolder, type });
  return fetch(`${COMFYUI_URL}/view?${params}`);
}

export async function uploadImage(
  file: Buffer,
  filename: string
): Promise<{ name: string; subfolder: string; type: string }> {
  const formData = new FormData();
  formData.append("image", new Blob([new Uint8Array(file)]), filename);
  formData.append("overwrite", "true");

  const res = await fetch(`${COMFYUI_URL}/upload/image`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Image upload failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Upload an input image into a per-job subfolder of the ComfyUI input dir
 * (type=input, overwrite=true). Returns the metadata plus `imageRef` — the
 * "subfolder/name" string a LoadImage node expects.
 */
export async function uploadInputImage(
  file: Buffer,
  filename: string,
  subfolder: string
): Promise<{ name: string; subfolder: string; type: string; imageRef: string }> {
  const formData = new FormData();
  formData.append("image", new Blob([new Uint8Array(file)]), filename);
  formData.append("type", "input");
  formData.append("subfolder", subfolder);
  formData.append("overwrite", "true");

  const res = await fetch(`${COMFYUI_URL}/upload/image`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Image upload failed (${res.status}): ${text}`);
  }

  const result = (await res.json()) as {
    name: string;
    subfolder?: string;
    type?: string;
  };
  const returnedSubfolder = result.subfolder || "";
  return {
    name: result.name,
    subfolder: returnedSubfolder,
    type: result.type || "input",
    imageRef: returnedSubfolder
      ? `${returnedSubfolder}/${result.name}`
      : result.name,
  };
}

/**
 * Upload an input AUDIO file (wav/mp3) into a per-job subfolder of the
 * ComfyUI input dir, mirroring uploadInputImage. ComfyUI has no separate
 * audio endpoint — /upload/image is the generic input-dir uploader (the form
 * field is named "image" regardless of content; core LoadAudio's own
 * audio_upload widget posts to the same route). Returns the metadata plus
 * `audioRef` — the "subfolder/name" string a LoadAudio node expects (it
 * resolves annotated filepaths exactly like LoadImage).
 */
export async function uploadInputAudio(
  file: Buffer,
  filename: string,
  subfolder: string
): Promise<{ name: string; subfolder: string; type: string; audioRef: string }> {
  const formData = new FormData();
  formData.append("image", new Blob([new Uint8Array(file)]), filename);
  formData.append("type", "input");
  formData.append("subfolder", subfolder);
  formData.append("overwrite", "true");

  const res = await fetch(`${COMFYUI_URL}/upload/image`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Audio upload failed (${res.status}): ${text}`);
  }

  const result = (await res.json()) as {
    name: string;
    subfolder?: string;
    type?: string;
  };
  const returnedSubfolder = result.subfolder || "";
  return {
    name: result.name,
    subfolder: returnedSubfolder,
    type: result.type || "input",
    audioRef: returnedSubfolder
      ? `${returnedSubfolder}/${result.name}`
      : result.name,
  };
}

/**
 * Upload an input VIDEO file (mp4/webm/mov) into a per-job subfolder of the
 * ComfyUI input dir, mirroring uploadInputImage/uploadInputAudio. ComfyUI has
 * no separate video endpoint — /upload/image is the generic input-dir
 * uploader (the form field is named "image" regardless of content; the
 * VHS_LoadVideo upload widget posts to the same route). Returns the metadata
 * plus `videoRef` — the "subfolder/name" string VHS_LoadVideo expects (its
 * VALIDATE_INPUTS resolves annotated filepaths like LoadImage, so this ref
 * and the "<subfolder>/<file> [output]" form from toAnnotatedOutputPath are
 * both valid values for its `video` input).
 */
export async function uploadInputVideo(
  file: Buffer,
  filename: string,
  subfolder: string
): Promise<{ name: string; subfolder: string; type: string; videoRef: string }> {
  const formData = new FormData();
  formData.append("image", new Blob([new Uint8Array(file)]), filename);
  formData.append("type", "input");
  formData.append("subfolder", subfolder);
  formData.append("overwrite", "true");

  const res = await fetch(`${COMFYUI_URL}/upload/image`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Video upload failed (${res.status}): ${text}`);
  }

  const result = (await res.json()) as {
    name: string;
    subfolder?: string;
    type?: string;
  };
  const returnedSubfolder = result.subfolder || "";
  return {
    name: result.name,
    subfolder: returnedSubfolder,
    type: result.type || "input",
    videoRef: returnedSubfolder
      ? `${returnedSubfolder}/${result.name}`
      : result.name,
  };
}

/**
 * Fetch only the LEADING bytes of a file in the ComfyUI input/output dirs
 * via /view + a Range request — enough for the video header probe
 * (src/lib/video-probe.ts reads faststart-MP4 moov / WebM Info+Tracks from
 * the head) WITHOUT downloading a multi-GB render. Accepts the same ref
 * forms VHS_LoadVideo does: "subfolder/name" (input dir) or the annotated
 * "<subfolder>/<file> [output]" form from toAnnotatedOutputPath. The body
 * stream is hard-capped at maxBytes even if the server ignores Range.
 * Best-effort: returns null on any failure (callers fall back gracefully).
 */
export async function getFileHeadBytes(
  fileRef: string,
  maxBytes: number,
): Promise<Buffer | null> {
  try {
    const annotated = fileRef.match(/^(.*?)\s*\[(output|input|temp)\]$/);
    const relPath = (annotated ? annotated[1] : fileRef).trim();
    const type = annotated ? annotated[2] : "input";
    const slash = relPath.lastIndexOf("/");
    const filename = slash >= 0 ? relPath.slice(slash + 1) : relPath;
    const subfolder = slash >= 0 ? relPath.slice(0, slash) : "";
    if (!filename) return null;

    const params = new URLSearchParams({ filename, subfolder, type });
    const res = await fetch(`${COMFYUI_URL}/view?${params}`, {
      headers: { Range: `bytes=0-${maxBytes - 1}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      return null;
    }

    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
    if (total >= maxBytes) await reader.cancel().catch(() => {});

    const buffer = Buffer.concat(chunks);
    return buffer.length > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
  } catch (error) {
    console.warn(
      "[FrameForge] head-bytes fetch failed (ignored):",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function getSystemStats(): Promise<Record<string, unknown>> {
  const res = await fetch(`${COMFYUI_URL}/system_stats`);
  if (!res.ok) throw new Error(`System stats failed: ${res.status}`);
  return res.json();
}

/**
 * Ask ComfyUI to unload models and free VRAM before a heavy video job.
 * Best-effort: failures are logged and swallowed — never blocks a dispatch.
 */
export async function freeComfyMemory(): Promise<void> {
  try {
    const res = await fetch(`${COMFYUI_URL}/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    console.log(
      `[FrameForge] ComfyUI /free (unload_models+free_memory): ${res.status}`
    );
  } catch (error) {
    console.warn(
      "[FrameForge] ComfyUI /free failed (ignored):",
      error instanceof Error ? error.message : error
    );
  }
}

export async function unloadOllamaModels(): Promise<void> {
  try {
    await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(2_000),
      body: JSON.stringify({
        model: "nemotron-3-nano:30b",
        keep_alive: 0,
      }),
    });
    console.log("[FrameForge] Ollama models evicted (keep_alive=0)");
  } catch {
    // Ollama might not be running, that's fine
  }
}

/**
 * Build a VHS_LoadVideo "annotated" path pointing at a file that lives in the
 * ComfyUI OUTPUT directory: "<subfolder>/<filename> [output]". Used by every
 * follow-on job (RIFE post, /api/finish upscalers) that consumes a clip a
 * previous job saved.
 */
export function toAnnotatedOutputPath(output: {
  filename: string;
  subfolder: string;
}): string {
  const relative = output.subfolder
    ? `${output.subfolder}/${output.filename}`
    : output.filename;
  return `${relative} [output]`;
}

/**
 * Extract output filename from ComfyUI history.
 * VHS_VideoCombine historically reports under 'gifs'; newer builds use
 * 'videos'; image nodes use 'images' — all three are handled.
 */
export function extractOutputFilename(
  history: ComfyUIHistoryItem
): { filename: string; subfolder: string } | null {
  // NOTE: an empty array is truthy, so `gifs || videos` would hide a
  // populated `videos` list behind an empty `gifs: []` — pick the first
  // NON-EMPTY list instead. `audio` covers the SaveAudio family (MUSIC
  // lane: SaveAudioMP3 → {"audio": [{filename, subfolder, type}]}).
  const filesOf = (nodeOutput: ComfyUIHistoryItem["outputs"][string]) =>
    [
      nodeOutput.gifs,
      nodeOutput.videos,
      nodeOutput.audio,
      nodeOutput.images,
    ].find((list) => Array.isArray(list) && list.length > 0);

  for (const nodeOutput of Object.values(history.outputs || {})) {
    const files = filesOf(nodeOutput);
    if (files && files.length > 0) {
      const file = files[0];
      if (
        file.filename.endsWith(".mp4") ||
        file.filename.endsWith(".webm") ||
        file.filename.endsWith(".mp3") ||
        file.filename.endsWith(".opus") ||
        file.filename.endsWith(".flac") ||
        file.filename.startsWith("FrameForge")
      ) {
        return { filename: file.filename, subfolder: file.subfolder || "" };
      }
    }
  }

  // Fallback: return first file found
  for (const nodeOutput of Object.values(history.outputs || {})) {
    const files = filesOf(nodeOutput);
    if (files && files.length > 0) {
      return {
        filename: files[0].filename,
        subfolder: files[0].subfolder || "",
      };
    }
  }

  return null;
}
