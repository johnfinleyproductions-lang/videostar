# GPU Hang Troubleshooting Guide

**Hardware:** NVIDIA RTX PRO 4500 Blackwell (32GB VRAM)  
**OS:** CachyOS (Arch Linux), Kernel 6.19.x  
**Driver:** NVIDIA 595.58.03 (Open Kernel Module)  
**CUDA:** Driver API 13.2, PyTorch nightly cu128  
**Date:** April 4, 2026

---

## What Happened

ComfyUI was running successfully with the GPU detected and 32GB VRAM available. During a restart after installing custom node pip packages (`diffusers`, `timm`, `opencv-python`), the previous ComfyUI process hadn't fully released the GPU. The new process crashed on CUDA initialization with:

```
torch.AcceleratorError: CUDA error: CUDA-capable device(s) is/are busy or unavailable
```

This left zombie Python processes stuck in an **uninterruptible kernel state (D state)** holding `/dev/nvidia*` device handles open. Each subsequent attempt to start ComfyUI or even run `nvidia-smi` added more zombie processes, making the situation worse.

## The Escalation

1. **Initial error:** "CUDA devices busy" on ComfyUI restart
2. **`kill -9` on zombie PIDs:** Failed — D-state processes can't be killed
3. **`sudo reboot`:** Failed — kernel couldn't cleanly shut down because D-state processes block the shutdown sequence. The machine appeared to reboot but the GPU firmware state was never cleared
4. **Hard power button press (hold 5-10 sec):** Appeared to work (`nvidia-smi` responded) but the GPU compute engine was still hung — the modeset subsystem was stuck in an error loop
5. **`nvidia-smi` working but CUDA broken:** nvidia-smi uses NVML (management library) which works through a different code path than CUDA compute. The management interface can report temperature, power, and memory while the actual compute engine is completely frozen

## How We Diagnosed It

### Step 1: Confirm CUDA runtime failure
```bash
cd ~/ComfyUI && source .venv/bin/activate
python -c "import torch; print('Devices:', torch.cuda.device_count())"
# Output: Devices: 0
```

### Step 2: Bypass PyTorch — test CUDA driver directly
```bash
python -c "
import ctypes
libcuda = ctypes.CDLL('libcuda.so.1')
print('cuInit:', libcuda.cuInit(0))
n = ctypes.c_int()
print('cuDeviceGetCount:', libcuda.cuDeviceGetCount(ctypes.byref(n)), 'count:', n.value)
"
# Output: cuInit: 999   (CUDA_ERROR_UNKNOWN)
# Output: cuDeviceGetCount: 3 count: 0
```
`cuInit` returning **999** (`CUDA_ERROR_UNKNOWN`) confirmed the problem was at the driver level, not PyTorch.

### Step 3: Check kernel logs
```bash
sudo dmesg | grep -i -E "nvidia|nvrm" | tail -20
```
**Smoking gun:**
```
nvidia-modeset: ERROR: GPU:0: Error while waiting for GPU progress: 0x0000ca7d:0 2:0:4048:4040
```
This error repeating every 5 seconds = **GPU compute engine hardware hang**. The modeset kernel module was continuously polling the GPU and getting no response from the compute engine.

## The Fix: Full Cold Shutdown + Power Disconnect

A soft reboot and even a hard power button press were not enough because PCIe devices can retain power through reboot cycles. The GPU's internal state (firmware, compute engine registers) was never fully cleared.

### Steps:
1. `sudo poweroff` (NOT `sudo reboot`)
2. Wait for all lights to go off
3. **Physically unplug the power cable** from the Framestation
4. **Wait 30 seconds** — this allows GPU capacitors to fully discharge
5. Plug the power cable back in
6. Press the power button to start the machine

### Verification after power cycle:
```bash
# 1. Check kernel logs are clean (no repeating GPU errors)
sudo dmesg | grep -i nvidia | tail -5

# 2. Test CUDA works
cd ~/ComfyUI && source .venv/bin/activate
python -c "import torch; print('Devices:', torch.cuda.device_count()); print(torch.cuda.get_device_name(0))"
# Expected: Devices: 1 / NVIDIA RTX PRO 4500 Blackwell

# 3. Start ComfyUI
python main.py --listen 0.0.0.0 --port 8188
```

## Prevention

### 1. Always stop ComfyUI cleanly before restarting
Press `Ctrl+C` in the ComfyUI terminal and **wait for it to fully exit** before starting a new instance. Never start a second instance while the first is still running.

### 2. Enable GPU persistence mode after boot
```bash
sudo nvidia-smi -pm 1
```
This keeps the GPU driver loaded between CUDA application runs, preventing slow reinitialization and reducing the chance of stuck states.

### 3. Stop Ollama before running ComfyUI
Ollama holds GPU memory. If both try to use the GPU simultaneously, crashes are likely.
```bash
sudo systemctl stop ollama
```

### 4. Check GPU state before starting ComfyUI
```bash
# Quick health check - should respond instantly
nvidia-smi

# Check nothing else is using the GPU
sudo lsof /dev/nvidia* 2>/dev/null
```

### 5. If `nvidia-smi` hangs or is slow
The GPU is in a bad state. **Do not** try to start ComfyUI. Go directly to the cold shutdown procedure above.

## Quick Reference: Diagnostic Commands

| Command | What it tells you |
|---------|------------------|
| `nvidia-smi` | GPU management status (works even when CUDA is broken) |
| `sudo lsof /dev/nvidia*` | What processes hold GPU device handles |
| `sudo fuser -k /dev/nvidia*` | Kill processes using GPU (won't work on D-state) |
| `sudo dmesg \| grep nvidia` | Kernel-level GPU errors |
| `python -c "import torch; print(torch.cuda.device_count())"` | Whether PyTorch can see the GPU |
| `cuInit` via ctypes test (see above) | Whether CUDA driver API works (bypasses PyTorch) |
| `cat /proc/driver/nvidia/version` | Kernel module version (should match driver) |

## Key Insight

**`nvidia-smi` working does NOT mean the GPU is healthy.** nvidia-smi uses NVML (a management API) which operates through a separate code path from CUDA compute. The GPU can report its temperature, power draw, and memory allocation while its compute engine is completely frozen. Always verify with an actual CUDA call (`torch.cuda.device_count()` or the `cuInit` ctypes test) before assuming the GPU is ready for work.
