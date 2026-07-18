"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { toast } from "sonner";
import {
  DEFAULT_VIDEO_MODEL_ID,
  LTX_VIDEO_MODEL,
  getVideoModelProfile,
  type VideoModelId,
} from "@/lib/models";
import type {
  VideoGenerationItem,
  VideoGenerationStatus,
  ResolutionPreset,
} from "@/lib/types";

const MAX_CONCURRENT = 1; // LTX-Video needs full VRAM
const POLL_INTERVAL = 3000;
const ESTIMATED_PROGRESS_INTERVAL = 1000;
const MAX_ESTIMATED_PROGRESS = 92;

function createLocalGenerationId() {
  return `local-${crypto.randomUUID?.() ?? Date.now().toString(36)}`;
}

function estimateGenerationMs(input: {
  width: number;
  height: number;
  duration: number;
  model: VideoModelId;
}) {
  const pixels = input.width * input.height;
  const sizeFactor = Math.max(1, pixels / (960 * 544));
  const modelProfile = getVideoModelProfile(input.model);
  const modelFactor =
    modelProfile.backend === "ltx-desktop"
      ? modelProfile.ltxDesktopRuntimeMode === "streaming_models_loading"
        ? 1.35
        : 1.15
      : 1;
  const estimatedSeconds = input.duration * 22 * sizeFactor * modelFactor;
  return Math.max(75_000, Math.min(20 * 60_000, estimatedSeconds * 1000));
}

export function useVideoStudio() {
  const [prompt, setPrompt] = useState("");
  const [selectedResolution, setSelectedResolution] = useState<ResolutionPreset>(
    LTX_VIDEO_MODEL.resolutionPresets[0]
  );
  const [duration, setDuration] = useState(4);
  const [fps, setFps] = useState(LTX_VIDEO_MODEL.defaultParams.fps);
  const [selectedModel, setSelectedModel] = useState<VideoModelId>(
    DEFAULT_VIDEO_MODEL_ID
  );
  const [sourceImage, setSourceImage] = useState<File | null>(null);
  const [queue, setQueue] = useState<VideoGenerationItem[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const pollingRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const estimatedProgressRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const eventSourceRef = useRef<EventSource | null>(null);

  const activeCount = queue.filter(
    (item) => item.status === "processing" || item.status === "pending"
  ).length;

  // Update queue item
  const updateQueueItem = useCallback(
    (id: string, update: Partial<VideoGenerationItem>) => {
      setQueue((prev) =>
        prev.map((item) => (item.id === id ? { ...item, ...update } : item))
      );
    },
    []
  );

  const stopEstimatedProgress = useCallback((id: string) => {
    const timer = estimatedProgressRef.current.get(id);
    if (timer) {
      clearInterval(timer);
      estimatedProgressRef.current.delete(id);
    }
  }, []);

  const startEstimatedProgress = useCallback(
    (id: string, estimatedMs: number) => {
      stopEstimatedProgress(id);
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        const eased = 1 - Math.exp(-elapsed / (estimatedMs * 0.55));
        const progress = Math.min(
          MAX_ESTIMATED_PROGRESS,
          Math.round(4 + eased * (MAX_ESTIMATED_PROGRESS - 4))
        );
        updateQueueItem(id, { progress });
      }, ESTIMATED_PROGRESS_INTERVAL);
      estimatedProgressRef.current.set(id, timer);
    },
    [stopEstimatedProgress, updateQueueItem]
  );

  // Poll for status
  const startPolling = useCallback(
    (id: string) => {
      const poll = async () => {
        try {
          const res = await fetch(`/api/status/${id}`);
          if (!res.ok) return;

          const data = await res.json();

          updateQueueItem(id, {
            status: data.status as VideoGenerationStatus,
            url: data.url,
            filename: data.filename,
            error: data.error,
            progress: data.progress,
          });

          if (data.status === "completed" || data.status === "failed") {
            // Stop polling
            const timer = pollingRef.current.get(id);
            if (timer) {
              clearInterval(timer);
              pollingRef.current.delete(id);
            }
            setIsGenerating(false);
          }
        } catch (error) {
          console.error("Poll error:", error);
        }
      };

      const timer = setInterval(poll, POLL_INTERVAL);
      pollingRef.current.set(id, timer);

      // Also poll immediately
      poll();
    },
    [updateQueueItem]
  );

  // Connect to SSE for real-time progress
  const connectProgress = useCallback(
    (id: string, clientId: string) => {
      // Close existing connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const es = new EventSource(`/api/ws?clientId=${clientId}`);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "progress" && msg.data) {
            const progress = (msg.data.value / msg.data.max) * 100;
            updateQueueItem(id, { progress });
          }

          if (
            msg.type === "executing" &&
            msg.data?.node === null
          ) {
            // Generation complete, trigger a status check
            setTimeout(() => {
              fetch(`/api/status/${id}`).then((res) => res.json()).then((data) => {
                updateQueueItem(id, {
                  status: data.status,
                  url: data.url,
                  filename: data.filename,
                  progress: 100,
                });
                setIsGenerating(false);
              });
            }, 1000);
            es.close();
          }
        } catch {
          // Ignore parse errors
        }
      };

      es.onerror = () => {
        // SSE failed, fall back to polling only
        es.close();
      };
    },
    [updateQueueItem]
  );

  // Generate
  const generate = useCallback(async () => {
    console.log("[FrameForge] Generate clicked", { prompt: prompt.trim(), activeCount, MAX_CONCURRENT });

    if (!prompt.trim()) {
      toast.error("Enter a prompt first");
      return;
    }
    if (activeCount >= MAX_CONCURRENT) {
      toast.error("A generation is already in progress");
      return;
    }

    setIsGenerating(true);
    toast.info("Queuing generation...");

    const generationPrompt = prompt.trim();
    const generationSourceImage = sourceImage;
    const modelProfile = getVideoModelProfile(selectedModel);
    const localId = createLocalGenerationId();
    const createdAt = new Date().toISOString();
    const optimisticItem: VideoGenerationItem = {
      id: localId,
      status: "processing",
      prompt: generationPrompt,
      width: selectedResolution.width,
      height: selectedResolution.height,
      fps,
      frames: fps * duration + 1,
      duration,
      resolution: selectedResolution.label,
      model: selectedModel,
      modelName: modelProfile.name,
      createdAt,
      progress: 3,
      sourceImageUrl: generationSourceImage?.name,
    };

    setQueue((prev) => [optimisticItem, ...prev]);
    startEstimatedProgress(
      localId,
      estimateGenerationMs({
        width: selectedResolution.width,
        height: selectedResolution.height,
        duration,
        model: selectedModel,
      })
    );

    try {
      // Upload source image if present
      let uploadedImageName: string | undefined;
      if (generationSourceImage) {
        updateQueueItem(localId, { progress: 5 });
        const formData = new FormData();
        formData.append("image", generationSourceImage);

        const uploadRes = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });

        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          uploadedImageName = uploadData.filename;
          updateQueueItem(localId, {
            progress: 8,
            sourceImageUrl: uploadedImageName,
          });
        }
      }

      updateQueueItem(localId, { progress: uploadedImageName ? 10 : 6 });
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          width: selectedResolution.width,
          height: selectedResolution.height,
          fps,
          duration,
          model: selectedModel,
          sourceImage: uploadedImageName,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Generation failed");
      }

      const data = await res.json();
      stopEstimatedProgress(localId);
      setQueue((prev) =>
        prev.map((item) =>
          item.id === localId
            ? {
                ...item,
                id: data.id,
                status:
                  data.status === "completed" ? "completed" : "processing",
                comfyPromptId: data.comfyPromptId,
                progress: data.status === "completed" ? 100 : item.progress,
                sourceImageUrl: uploadedImageName,
              }
            : item
        )
      );
      setPrompt("");
      setSourceImage(null);

      // Start real-time progress + polling fallback
      if (data.clientId) {
        connectProgress(data.id, data.clientId);
      }
      startPolling(data.id);
    } catch (error) {
      stopEstimatedProgress(localId);
      console.error("Generate error:", error);
      const message = error instanceof Error ? error.message : "Generation failed";
      updateQueueItem(localId, {
        status: "failed",
        error: message,
      });
      toast.error(message);
      setIsGenerating(false);
    }
  }, [
    prompt,
    selectedResolution,
    selectedModel,
    fps,
    duration,
    sourceImage,
    activeCount,
    startPolling,
    connectProgress,
    startEstimatedProgress,
    stopEstimatedProgress,
    updateQueueItem,
  ]);

  // Remove from queue
  const removeFromQueue = useCallback(
    (id: string) => {
      setQueue((prev) => prev.filter((item) => item.id !== id));
      const timer = pollingRef.current.get(id);
      if (timer) {
        clearInterval(timer);
        pollingRef.current.delete(id);
      }
      stopEstimatedProgress(id);
    },
    [stopEstimatedProgress]
  );

  // Cleanup on unmount
  useEffect(() => {
    const polling = pollingRef.current;
    const estimatedProgress = estimatedProgressRef.current;
    return () => {
      polling.forEach((timer) => clearInterval(timer));
      estimatedProgress.forEach((timer) => clearInterval(timer));
      eventSourceRef.current?.close();
    };
  }, []);

  return {
    // State
    prompt,
    setPrompt,
    selectedResolution,
    setSelectedResolution,
    duration,
    setDuration,
    fps,
    setFps,
    selectedModel,
    setSelectedModel,
    sourceImage,
    setSourceImage,
    queue,
    isGenerating,
    activeCount,

    // Actions
    generate,
    removeFromQueue,
    updateQueueItem,
  };
}
