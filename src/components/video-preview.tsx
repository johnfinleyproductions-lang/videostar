"use client";

import { useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Download,
  ChevronLeft,
  ChevronRight,
  Film,
  Clock,
  Hash,
} from "lucide-react";
import type { VideoCreation } from "@/lib/types";

interface VideoPreviewProps {
  open: boolean;
  creations: VideoCreation[];
  currentIndex: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onDownload: (creation: VideoCreation) => void;
}

export function VideoPreview({
  open,
  creations,
  currentIndex,
  onClose,
  onPrev,
  onNext,
  onDownload,
}: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const current = creations[currentIndex];

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;

    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          onClose();
          break;
        case "ArrowLeft":
          onPrev();
          break;
        case "ArrowRight":
          onNext();
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, onPrev, onNext]);

  // Autoplay when changing videos
  useEffect(() => {
    if (videoRef.current && current?.url) {
      videoRef.current.load();
      videoRef.current.play().catch(() => {});
    }
  }, [current?.url]);

  if (!open || !current) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/95 flex flex-col"
        onClick={onClose}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 shrink-0">
          <div className="flex items-center gap-3 text-sm text-zinc-400">
            <span>
              {currentIndex + 1} / {creations.length}
            </span>
            {current.resolution && (
              <span className="flex items-center gap-1">
                <Film className="w-3 h-3" />
                {current.resolution}
              </span>
            )}
            {current.duration && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {current.duration}s
              </span>
            )}
            {current.seed && (
              <span className="flex items-center gap-1">
                <Hash className="w-3 h-3" />
                {current.seed}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDownload(current);
              }}
              className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            >
              <Download className="w-5 h-5" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Video */}
        <div
          className="flex-1 flex items-center justify-center px-16 min-h-0"
          onClick={(e) => e.stopPropagation()}
        >
          <video
            ref={videoRef}
            src={current.url}
            className="max-w-full max-h-full rounded-lg"
            controls
            autoPlay
            loop
          />
        </div>

        {/* Prompt */}
        <div className="p-4 text-center shrink-0">
          <p className="text-sm text-zinc-400 max-w-2xl mx-auto line-clamp-2">
            {current.prompt}
          </p>
        </div>

        {/* Navigation */}
        {currentIndex > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPrev();
            }}
            className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-zinc-900/80 text-white hover:bg-zinc-800 transition-colors"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        )}
        {currentIndex < creations.length - 1 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onNext();
            }}
            className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-zinc-900/80 text-white hover:bg-zinc-800 transition-colors"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
