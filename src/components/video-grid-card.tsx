"use client";

import { useRef, useState, useCallback } from "react";
import { motion } from "framer-motion";
import {
  Play,
  Download,
  Trash2,
  Loader2,
  AlertCircle,
  Clock,
  Film,
} from "lucide-react";
import type { VideoCreation } from "@/lib/types";

interface VideoGridCardProps {
  creation: VideoCreation;
  onClick: (creation: VideoCreation) => void;
  onDownload: (creation: VideoCreation) => void;
  onDelete: (creation: VideoCreation) => void;
}

export function VideoGridCard({
  creation,
  onClick,
  onDownload,
  onDelete,
}: VideoGridCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isHovered, setIsHovered] = useState(false);

  const handleMouseEnter = useCallback(() => {
    setIsHovered(true);
    if (videoRef.current && creation.url) {
      videoRef.current.play().catch(() => {});
    }
  }, [creation.url]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  }, []);

  const isProcessing =
    creation.status === "processing" || creation.status === "pending";
  const isFailed = creation.status === "failed";
  const isCompleted = creation.status === "completed" && creation.url;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="group relative aspect-video rounded-xl overflow-hidden bg-zinc-900 border border-zinc-800 cursor-pointer transition-all hover:border-zinc-600 hover:shadow-lg hover:shadow-purple-500/5"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={() => isCompleted && onClick(creation)}
    >
      {/* Video / Thumbnail */}
      {isCompleted && (
        <video
          ref={videoRef}
          src={creation.url}
          className="absolute inset-0 w-full h-full object-cover"
          muted
          loop
          playsInline
          preload="metadata"
        />
      )}

      {/* Processing State */}
      {isProcessing && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-900">
          <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
          <div className="text-sm text-zinc-400">
            {creation.progress
              ? `${Math.round(creation.progress)}%`
              : "Generating..."}
          </div>
          {creation.progress !== undefined && creation.progress > 0 && (
            <div className="w-32 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-purple-500 rounded-full transition-all duration-300"
                style={{ width: `${creation.progress}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Failed State */}
      {isFailed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-900">
          <AlertCircle className="w-8 h-8 text-red-400" />
          <div className="text-sm text-red-400">Failed</div>
          <div className="text-xs text-zinc-500 px-4 text-center truncate max-w-full">
            {creation.error || "Generation failed"}
          </div>
        </div>
      )}

      {/* Hover Overlay */}
      {isCompleted && (
        <div
          className={`absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent transition-opacity duration-200 ${
            isHovered ? "opacity-100" : "opacity-0"
          }`}
        >
          {/* Play Icon */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
              <Play className="w-6 h-6 text-white ml-0.5" fill="white" />
            </div>
          </div>

          {/* Bottom Info */}
          <div className="absolute bottom-0 left-0 right-0 p-3">
            <p className="text-sm text-white/90 line-clamp-2 mb-2">
              {creation.prompt}
            </p>
            <div className="flex items-center gap-3 text-xs text-zinc-400">
              {creation.resolution && (
                <span className="flex items-center gap-1">
                  <Film className="w-3 h-3" />
                  {creation.resolution}
                </span>
              )}
              {creation.duration && (
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {creation.duration}s
                </span>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="absolute top-2 right-2 flex gap-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDownload(creation);
              }}
              className="p-1.5 rounded-lg bg-black/50 backdrop-blur-sm text-white/80 hover:text-white hover:bg-black/70 transition-colors"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(creation);
              }}
              className="p-1.5 rounded-lg bg-black/50 backdrop-blur-sm text-white/80 hover:text-red-400 hover:bg-black/70 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Status Badge */}
      {isProcessing && (
        <div className="absolute top-2 left-2">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-500/20 text-purple-300 border border-purple-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
            Processing
          </span>
        </div>
      )}
    </motion.div>
  );
}
