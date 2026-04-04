"use client";

import { useCallback, useMemo, useState } from "react";
import { toast, Toaster } from "sonner";
import { VideoGallery } from "./video-gallery";
import { VideoFloatingBar } from "./video-floating-bar";
import { VideoPreview } from "./video-preview";
import { useVideoStudio } from "@/hooks/use-video-studio";
import { useVideoCreations } from "@/hooks/use-video-creations";
import type { VideoCreation } from "@/lib/types";

function isPlayableVideoUrl(url?: string) {
  if (!url) return false;
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("/")
  );
}

export function VideoStudio() {
  const studio = useVideoStudio();
  const {
    creations,
    isLoading,
    hasMore,
    searchQuery,
    refresh,
    loadMore,
    handleSearch,
  } = useVideoCreations(studio.queue);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);

  // Filter to playable videos for the preview lightbox
  const previewableCreations = useMemo(
    () =>
      creations.filter(
        (c) =>
          isPlayableVideoUrl(c.url) &&
          c.status !== "failed" &&
          c.status !== "pending" &&
          c.status !== "processing"
      ),
    [creations]
  );

  const openPreview = useCallback(
    (creation: VideoCreation) => {
      const index = previewableCreations.findIndex(
        (c) => c.id === creation.id
      );
      if (index === -1) return;
      setPreviewIndex(index);
      setPreviewOpen(true);
    },
    [previewableCreations]
  );

  const handleDownload = useCallback((creation: VideoCreation) => {
    if (!creation.url) return;
    const link = document.createElement("a");
    link.href = creation.url;
    link.download = `frameforge-${creation.id.slice(0, 8)}.mp4`;
    link.target = "_blank";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success("Download started");
  }, []);

  const handleDelete = useCallback(
    async (creation: VideoCreation) => {
      try {
        const res = await fetch("/api/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: creation.id }),
        });

        if (!res.ok) throw new Error("Delete failed");

        // Remove from queue if it's a session item
        if (creation.isSessionItem) {
          studio.removeFromQueue(creation.id);
        }

        refresh();
        toast.success("Deleted");
      } catch {
        toast.error("Failed to delete");
      }
    },
    [refresh, studio]
  );

  const handleGenerate = useCallback(() => {
    studio.generate();
    // Refresh gallery after a delay to pick up the new item
    setTimeout(refresh, 2000);
  }, [studio, refresh]);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-black">
      <Toaster
        theme="dark"
        position="top-right"
        toastOptions={{
          style: {
            background: "#18181b",
            border: "1px solid #27272a",
            color: "#e4e4e7",
          },
        }}
      />

      {/* Header */}
      <header className="shrink-0 px-6 py-4 border-b border-zinc-900 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
            <span className="text-white text-sm font-bold">F</span>
          </div>
          <div>
            <h1 className="text-base font-semibold text-white tracking-tight">
              FrameForge
            </h1>
            <p className="text-xs text-zinc-500">
              Local AI Video Studio
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-600">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          LTX-Video 2.3 &middot; RTX PRO 4500
        </div>
      </header>

      {/* Gallery */}
      <VideoGallery
        creations={creations}
        isLoading={isLoading}
        hasMore={hasMore}
        searchQuery={searchQuery}
        onSearchChange={handleSearch}
        onLoadMore={loadMore}
        onPreview={openPreview}
        onDownload={handleDownload}
        onDelete={handleDelete}
      />

      {/* Floating Bar */}
      <VideoFloatingBar
        prompt={studio.prompt}
        onPromptChange={studio.setPrompt}
        selectedResolution={studio.selectedResolution}
        onResolutionChange={studio.setSelectedResolution}
        duration={studio.duration}
        onDurationChange={studio.setDuration}
        fps={studio.fps}
        onFpsChange={studio.setFps}
        sourceImage={studio.sourceImage}
        onSourceImageChange={studio.setSourceImage}
        isGenerating={studio.isGenerating}
        activeCount={studio.activeCount}
        onGenerate={handleGenerate}
      />

      {/* Preview Lightbox */}
      <VideoPreview
        open={previewOpen}
        creations={previewableCreations}
        currentIndex={previewIndex}
        onClose={() => setPreviewOpen(false)}
        onPrev={() => setPreviewIndex((i) => Math.max(0, i - 1))}
        onNext={() =>
          setPreviewIndex((i) =>
            Math.min(previewableCreations.length - 1, i + 1)
          )
        }
        onDownload={handleDownload}
      />
    </div>
  );
}
