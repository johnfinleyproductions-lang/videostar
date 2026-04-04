"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { VideoCreation, VideoGenerationItem } from "@/lib/types";

const PAGE_SIZE = 20;

export function useVideoCreations(queue: VideoGenerationItem[]) {
  const [persisted, setPersisted] = useState<VideoCreation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const searchDebounceRef = useRef<NodeJS.Timeout>(undefined);

  // Fetch persisted history
  const fetchHistory = useCallback(
    async (newOffset: number, search: string, append: boolean = false) => {
      setIsLoading(true);
      try {
        const params = new URLSearchParams({
          offset: String(newOffset),
          limit: String(PAGE_SIZE),
        });
        if (search) params.set("search", search);

        const res = await fetch(`/api/history?${params}`);
        if (!res.ok) return;

        const data = await res.json();

        setPersisted((prev) =>
          append ? [...prev, ...data.items] : data.items
        );
        setHasMore(data.hasMore);
        setOffset(newOffset + data.items.length);
      } catch (error) {
        console.error("Fetch history error:", error);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  // Initial load
  useEffect(() => {
    fetchHistory(0, "");
  }, [fetchHistory]);

  // Refresh (reload from beginning)
  const refresh = useCallback(() => {
    fetchHistory(0, searchQuery);
  }, [fetchHistory, searchQuery]);

  // Load more
  const loadMore = useCallback(() => {
    if (!isLoading && hasMore) {
      fetchHistory(offset, searchQuery, true);
    }
  }, [fetchHistory, offset, searchQuery, isLoading, hasMore]);

  // Search with debounce
  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query);
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
      searchDebounceRef.current = setTimeout(() => {
        fetchHistory(0, query);
      }, 300);
    },
    [fetchHistory]
  );

  // Merge queue items with persisted items (deduplicate by id)
  const creations: VideoCreation[] = (() => {
    const queueIds = new Set(queue.map((q) => q.id));

    // Queue items (session only) first
    const queueCreations: VideoCreation[] = queue.map((item) => ({
      id: item.id,
      url: item.url || "",
      prompt: item.prompt,
      createdAt: item.createdAt,
      status: item.status,
      error: item.error,
      width: item.width,
      height: item.height,
      fps: item.fps,
      frames: item.frames,
      duration: item.duration,
      resolution: item.resolution,
      progress: item.progress,
      sourceImageUrl: item.sourceImageUrl,
      seed: item.seed,
      filename: item.filename,
      isSessionItem: true,
    }));

    // Persisted items (exclude any that are in queue)
    const persistedFiltered = persisted.filter((p) => !queueIds.has(p.id));

    return [...queueCreations, ...persistedFiltered];
  })();

  return {
    creations,
    isLoading,
    hasMore,
    searchQuery,
    refresh,
    loadMore,
    handleSearch,
  };
}
