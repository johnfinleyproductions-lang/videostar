import { lstat, readFile } from "node:fs/promises";

/** Credentials belong to one configured Comfy origin, never a caller URL. */
export async function comfyHeaders(raw: string): Promise<Record<string, string>> {
  const keyFile = process.env.EVERGREEN_PRIVATE_IMAGE_KEY_FILE;
  const privateOrigin = process.env.EVERGREEN_PRIVATE_COMFY_ORIGIN;
  if (!keyFile || !privateOrigin) return {};
  const url = new URL(raw);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.origin !== new URL(privateOrigin).origin || url.username || url.password) return {};
  const info = await lstat(keyFile);
  // Windows ACLs provide file permissions; Linux/macOS must also be owner-only.
  if (!info.isFile() || (process.platform !== "win32" && ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())))) {
    throw new Error("Private Comfy credential is unavailable");
  }
  const token = (await readFile(keyFile, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Private Comfy credential is unavailable");
  return { Authorization: `Bearer ${token}` };
}

export async function comfyFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(await comfyHeaders(url))) headers.set(name, value);
  return fetch(url, { ...init, headers, redirect: "error" });
}

/** Private graphs and their failure inputs must never reach public status APIs. */
export function isPrivateHistory(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const prompt = (item as { prompt?: unknown[] }).prompt;
  if (!Array.isArray(prompt)) return false;
  const graph = prompt[2];
  return Boolean(graph && typeof graph === "object" && Object.values(graph).some(node =>
    typeof node?.class_type === "string" && node.class_type.startsWith("EvergreenPrivate")));
}
