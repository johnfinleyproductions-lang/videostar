"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { v4 as uuidv4 } from "uuid";
import { LTX_VIDEO_MODEL } from "@/lib/models";
import type {
  VideoGenerationItem,
  VideoGenerationStatus,
  ResolutionPreset,
} from "@/lib/types";

const MAX_CONCURRENT = 1; // LTX-Video needs full VRAM
const POLL_INTERVAL = 3000;

export function useVideoStudio() {
  const [prompt, setPrompt] = useState("");
  const [selectedResolution, setSelectedResolution] = useState<ResolutionPreset>(
    LTX_VIDEO_MODEL.resolutionPresets[0]
  );
  const [duration, setDuration] = useState(4);
  const [fps, setFps] = useState(LTX_VIDEO_MODEL.defaultParams.fps);
  const [sourceImage, setSourceImage] = useState<File | null>(null);
  const [queue, setQueue] = useState<VideoGenerationItem[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const pollingRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
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
    if (!prompt.trim() || activeCount >= MAX_CONCURRENT) return;

    setIsGenerating(true);

    try {
      // Upload source image if present
      let uploadedImageName: string | undefined;
      if (sourceImage) {
        const formData = new FormData();
        formData.append("image", sourceImage);

        const uploadRes = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });

        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          uploadedImageName = uploadData.filename;
        }
      }

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          width: selectedResolution.width,
          height: selectedResolution.height,
          fps,
          duration,
          sourceImage: uploadedImageName,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Generation failed");
      }

      const data = await res.json();

      // Add to queue
      const item: VideoGenerationItem = {
        id: data.id,
        status: "processing",
        prompt: prompt.trim(),
        comfyPromptId: data.comfyPromptId,
        width: selectedResolution.width,
        height: selectedResolution.height,
        fps,
        frames: fps * duration + 1,
        duration,
        resolution: selectedResolution.label,
        createdAt: new Date().toISOString(),
        progress: 0,
        sourceImageUrl: uploadedImageName,
      };

      setQueue((prev) => [item, ...prev]);
      setPrompt("");
      setSourceImage(null);

      // Start real-time progress + polling fallback
      if (data.clientId) {
        connectProgress(data.id, data.clientId);
      }
      startPolling(data.id);
    } catch (error) {
      console.error("Generate error:", error);
      setIsGenerating(false);
    }
  }, [
    prompt,
    selectedResolution,
    fps,
    duration,
    sourceImage,
    activeCount,
    startPolling,
    connectProgress,
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
    },
    []
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      pollingRef.current.forEach((timer) => clearInterval(timer));
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
