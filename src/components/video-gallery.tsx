"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Search, Film, Sparkles } from "lucide-react";
import { VideoGridCard } from "./video-grid-card";
import type { VideoCreation } from "@/lib/types";

interface VideoGalleryProps {
  creations: VideoCreation[];
  isLoading: boolean;
  hasMore: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onLoadMore: () => void;
  onPreview: (creation: VideoCreation) => void;
  onDownload: (creation: VideoCreation) => void;
  onDelete: (creation: VideoCreation) => void;
}

export function VideoGallery({
  creations,
  isLoading,
  hasMore,
  searchQuery,
  onSearchChange,
  onLoadMore,
  onPreview,
  onDownload,
  onDelete,
}: VideoGalleryProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [showSearch, setShowSearch] = useState(false);

  // Infinite scroll
  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (entries[0].isIntersecting && hasMore && !isLoading) {
        onLoadMore();
      }
    },
    [hasMore, isLoading, onLoadMore]
  );

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(handleIntersect, {
      rootMargin: "200px",
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleIntersect]);

  const isEmpty = creations.length === 0 && !isLoading;

  return (
    <div className="flex-1 overflow-y-auto px-4 pt-4 pb-32">
      {/* Search Bar */}
      {(creations.length > 0 || searchQuery) && (
        <div className="max-w-3xl mx-auto mb-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search your generations..."
              className="w-full pl-10 pr-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-xl text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-colors"
            />
          </div>
        </div>
      )}

      {/* Empty State */}
      {isEmpty && !searchQuery && (
        <div className="flex flex-col items-center justify-center h-full min-h-[60vh] gap-4">
          <div className="w-20 h-20 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <Film className="w-10 h-10 text-zinc-600" />
          </div>
          <div className="text-center">
            <h3 className="text-lg font-medium text-zinc-300 mb-1">
              No videos yet
            </h3>
            <p className="text-sm text-zinc-500 max-w-md">
              Type a prompt below and hit Generate to create your first video
              with LTX-Video 2.3
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-600">
            <Sparkles className="w-3 h-3" />
            <span>Running locally on RTX PRO 4500 &middot; 32GB VRAM</span>
          </div>
        </div>
      )}

      {/* Empty Search State */}
      {isEmpty && searchQuery && (
        <div className="flex flex-col items-center justify-center h-[40vh] gap-3">
          <Search className="w-10 h-10 text-zinc-600" />
          <p className="text-sm text-zinc-500">
            No results for &ldquo;{searchQuery}&rdquo;
          </p>
        </div>
      )}

      {/* Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-w-7xl mx-auto">
        <AnimatePresence mode="popLayout">
          {creations.map((creation) => (
            <VideoGridCard
              key={creation.id}
              creation={creation}
              onClick={onPreview}
              onDownload={onDownload}
              onDelete={onDelete}
            />
          ))}
        </AnimatePresence>
      </div>

      {/* Load More Sentinel */}
      <div ref={sentinelRef} className="h-4" />

      {/* Loading */}
      {isLoading && (
        <div className="flex justify-center py-8">
          <div className="w-6 h-6 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
}
