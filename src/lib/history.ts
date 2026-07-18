// FrameForge — Local JSON History Store
// Replaces Supabase with a simple JSON file for personal use

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import type { VideoGenerationItem } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

export async function readHistory(): Promise<VideoGenerationItem[]> {
  await ensureDataDir();
  try {
    const data = await readFile(HISTORY_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function writeHistory(items: VideoGenerationItem[]): Promise<void> {
  await ensureDataDir();
  await writeFile(HISTORY_FILE, JSON.stringify(items, null, 2));
}

export async function addToHistory(
  item: VideoGenerationItem
): Promise<void> {
  const items = await readHistory();
  // Prepend (newest first)
  items.unshift(item);
  await writeHistory(items);
}

export async function updateHistoryItem(
  id: string,
  update: Partial<VideoGenerationItem>
): Promise<void> {
  const items = await readHistory();
  const index = items.findIndex((item) => item.id === id);
  if (index !== -1) {
    items[index] = { ...items[index], ...update };
    await writeHistory(items);
  }
}

export async function deleteHistoryItem(id: string): Promise<string | null> {
  const items = await readHistory();
  const item = items.find((i) => i.id === id);
  const filename = item?.filename || null;
  const filtered = items.filter((i) => i.id !== id);
  await writeHistory(filtered);
  return filename;
}

export async function getHistoryItem(
  id: string
): Promise<VideoGenerationItem | null> {
  const items = await readHistory();
  return items.find((i) => i.id === id) || null;
}
