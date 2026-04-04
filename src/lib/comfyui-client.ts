// FrameForge — ComfyUI HTTP Client
// IMPORTANT: Always use 127.0.0.1, NEVER localhost (IPv6 issue on CachyOS)

const COMFYUI_URL = process.env.COMFYUI_URL || "http://127.0.0.1:8188";

interface ComfyUIPromptResponse {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

interface ComfyUIHistoryItem {
  outputs: Record<
    string,
    {
      gifs?: Array<{
        filename: string;
        subfolder: string;
        type: string;
      }>;
      images?: Array<{
        filename: string;
        subfolder: string;
        type: string;
      }>;
    }
  >;
  status: {
    status_str: string;
    completed: boolean;
  };
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
    throw new Error(`ComfyUI queue failed (${res.status}): ${text}`);
  }

  return res.json();
}

export async function getHistory(
  promptId: string
): Promise<ComfyUIHistoryItem | null> {
  const res = await fetch(`${COMFYUI_URL}/history/${promptId}`);
  if (!res.ok) return null;

  const data = await res.json();
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

export async function getSystemStats(): Promise<Record<string, unknown>> {
  const res = await fetch(`${COMFYUI_URL}/system_stats`);
  if (!res.ok) throw new Error(`System stats failed: ${res.status}`);
  return res.json();
}

export async function unloadOllamaModels(): Promise<void> {
  try {
    await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "nemotron-3-nano:30b",
        keep_alive: 0,
      }),
    });
  } catch {
    // Ollama might not be running, that's fine
  }
}

/**
 * Extract output filename from ComfyUI history.
 * Looks for VHS_VideoCombine output (gifs key) or any output with video files.
 */
export function extractOutputFilename(
  history: ComfyUIHistoryItem
): { filename: string; subfolder: string } | null {
  for (const nodeOutput of Object.values(history.outputs)) {
    // VHS_VideoCombine uses 'gifs' key for video output
    const files = nodeOutput.gifs || nodeOutput.images;
    if (files && files.length > 0) {
      const file = files[0];
      if (
        file.filename.endsWith(".mp4") ||
        file.filename.endsWith(".webm") ||
        file.filename.startsWith("FrameForge")
      ) {
        return { filename: file.filename, subfolder: file.subfolder || "" };
      }
    }
  }

  // Fallback: return first file found
  for (const nodeOutput of Object.values(history.outputs)) {
    const files = nodeOutput.gifs || nodeOutput.images;
    if (files && files.length > 0) {
      return {
        filename: files[0].filename,
        subfolder: files[0].subfolder || "",
      };
    }
  }

  return null;
}
