"use client";

import { useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send,
  Image as ImageIcon,
  X,
  ChevronUp,
  ChevronDown,
  Loader2,
  Settings2,
  Zap,
} from "lucide-react";
import { LTX_VIDEO_MODEL, getVramEstimate } from "@/lib/models";
import type { ResolutionPreset } from "@/lib/types";

interface VideoFloatingBarProps {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  selectedResolution: ResolutionPreset;
  onResolutionChange: (preset: ResolutionPreset) => void;
  duration: number;
  onDurationChange: (duration: number) => void;
  fps: number;
  onFpsChange: (fps: number) => void;
  sourceImage: File | null;
  onSourceImageChange: (file: File | null) => void;
  isGenerating: boolean;
  activeCount: number;
  onGenerate: () => void;
}

export function VideoFloatingBar({
  prompt,
  onPromptChange,
  selectedResolution,
  onResolutionChange,
  duration,
  onDurationChange,
  fps,
  onFpsChange,
  sourceImage,
  onSourceImageChange,
  isGenerating,
  activeCount,
  onGenerate,
}: VideoFloatingBarProps) {
  const [showSettings, setShowSettings] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!isGenerating && prompt.trim()) {
          onGenerate();
        }
      }
    },
    [isGenerating, prompt, onGenerate]
  );

  const handleImageSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        onSourceImageChange(file);
      }
    },
    [onSourceImageChange]
  );

  const vramEstimate = getVramEstimate(
    selectedResolution.width,
    selectedResolution.height
  );

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40">
      <div className="max-w-3xl mx-auto px-4 pb-4">
        {/* Settings Panel */}
        <AnimatePresence>
          {showSettings && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              className="mb-2 p-4 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl"
            >
              {/* Resolution */}
              <div className="mb-4">
                <label className="text-xs font-medium text-zinc-400 mb-2 block">
                  Resolution{" "}
                  <span className="text-zinc-600">({vramEstimate} VRAM)</span>
                </label>
                <div className="flex gap-2">
                  {LTX_VIDEO_MODEL.resolutionPresets.map((preset) => (
                    <button
                      key={preset.label}
                      onClick={() => onResolutionChange(preset)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        selectedResolution.label === preset.label
                          ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                          : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-600"
                      }`}
                    >
                      {preset.label}
                      <span className="text-xs text-zinc-500 ml-1">
                        {preset.width}x{preset.height}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Duration */}
              <div className="mb-4">
                <label className="text-xs font-medium text-zinc-400 mb-2 block">
                  Duration
                </label>
                <div className="flex gap-2 flex-wrap">
                  {LTX_VIDEO_MODEL.durationPresets.map((d) => (
                    <button
                      key={d}
                      onClick={() => onDurationChange(d)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        duration === d
                          ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                          : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-600"
                      }`}
                    >
                      {d}s
                    </button>
                  ))}
                </div>
              </div>

              {/* FPS */}
              <div>
                <label className="text-xs font-medium text-zinc-400 mb-2 block">
                  Frame Rate
                </label>
                <div className="flex gap-2">
                  {LTX_VIDEO_MODEL.fpsOptions.map((f) => (
                    <button
                      key={f}
                      onClick={() => onFpsChange(f)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        fps === f
                          ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                          : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-600"
                      }`}
                    >
                      {f} fps
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Source Image Preview */}
        {sourceImage && (
          <div className="mb-2 flex items-center gap-2 px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl">
            <ImageIcon className="w-4 h-4 text-purple-400 shrink-0" />
            <span className="text-sm text-zinc-300 truncate flex-1">
              {sourceImage.name}
            </span>
            <button
              onClick={() => onSourceImageChange(null)}
              className="p-1 rounded-md text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Main Bar */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl shadow-black/50">
          <div className="flex items-end gap-2 p-3">
            {/* Settings Toggle */}
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`shrink-0 p-2.5 rounded-xl transition-colors ${
                showSettings
                  ? "bg-purple-500/20 text-purple-300"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              <Settings2 className="w-5 h-5" />
            </button>

            {/* Image Upload */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageSelect}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0 p-2.5 rounded-xl text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
              title="Upload source image for image-to-video"
            >
              <ImageIcon className="w-5 h-5" />
            </button>

            {/* Prompt Input */}
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => onPromptChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe your video..."
              rows={1}
              className="flex-1 bg-transparent text-white placeholder:text-zinc-500 resize-none border-none outline-none text-sm py-2.5 max-h-32 scrollbar-thin"
              style={{ minHeight: "2.5rem" }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = "auto";
                target.style.height = `${Math.min(target.scrollHeight, 128)}px`;
              }}
            />

            {/* Status Pill */}
            {activeCount > 0 && (
              <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-purple-500/10 text-purple-300 text-xs font-medium">
                <Zap className="w-3 h-3" />
                {activeCount} active
              </div>
            )}

            {/* Generate Button */}
            <button
              onClick={onGenerate}
              disabled={isGenerating || !prompt.trim()}
              className="shrink-0 p-2.5 rounded-xl bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isGenerating ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </button>
          </div>

          {/* Bottom Info Strip */}
          <div className="px-4 pb-2 flex items-center justify-between text-xs text-zinc-600">
            <span>
              LTX-Video 2.3 &middot; {selectedResolution.label} &middot;{" "}
              {duration}s &middot; {fps}fps
            </span>
            <span>Enter to generate &middot; Shift+Enter for newline</span>
          </div>
        </div>
      </div>
    </div>
  );
}
