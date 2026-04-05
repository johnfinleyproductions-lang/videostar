# FrameForge

> **Local AI video generation studio** — a Next.js frontend that talks to a self-hosted ComfyUI backend on a GPU machine (the "Framestation") to generate video from text prompts using LTX-Video 2.3.

GitHub repo name is `videostar` for historical reasons. **The app is called FrameForge.**

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.** The sections below contain everything you need to know about the environment, paths, ports, known issues, and current status. Do not ask the user to re-explain any of this — it's all documented here. Update the [Session Handoff](#session-handoff) section at the end of every work session so the next session can pick up without going in circles.

**Top-7 gotchas that burn every session:**
1. **ComfyUI runs inside a Python venv** at `~/ComfyUI/.venv`. Always `source ~/ComfyUI/.venv/bin/activate` BEFORE any `pip` or `python -c "import ..."` command. System `/usr/bin/python` has no pip and no cv2 — anything you install there is invisible to ComfyUI.
2. **`next dev` does NOT read `PORT` from `.env.local`.** Always start FrameForge with `PORT=3060 npm run dev`, or patch the `dev` script to `"next dev -p 3060"`.
3. **No stray `package.json` in `/home/lynf/`** — it breaks Turbopack workspace detection and causes `Can't resolve 'tailwindcss'`.
4. **`ssh frame` only works from the Mac.** The alias lives in the Mac's `~/.ssh/config`. If you're already SSH'd into the Framestation, skip it — running `ssh frame` on the box itself will fail with `Could not resolve hostname frame`.
5. **Services die when their terminal closes.** Both ComfyUI and `npm run dev` are foreground processes. Close the SSH tab or Ctrl+C → the service is gone. **Always run them inside tmux** (`tmux new -s comfy` and `tmux new -s frame`) so they survive disconnects. Better: use the `frame` shortcut script (see Daily Startup).
6. **🔥 PyTorch CUDA version MUST match the NVIDIA driver CUDA version.** If ComfyUI prints `WARNING: You need pytorch with cu130 or higher to use optimized CUDA operations` at startup, **stop immediately**. Reinstall PyTorch from the matching nightly (`--index-url https://download.pytorch.org/whl/nightly/cu130` for CUDA 13.x driver). Historically caused the `Host is down` crashes — but see gotcha #7, cu130 fixes the warning but is NOT sufficient on its own.
7. **🔥🔥 Ollama is a GPU squatter on this box.** Ollama runs on `127.0.0.1:11434` and holds models in VRAM. When ComfyUI starts and calls `torch.cuda.mem_get_info()`, it can get `cudaErrorDevicesUnavailable` ("device(s) is/are busy or unavailable") — and on Blackwell that error has repeatedly been followed seconds later by a **full box lockup** (SSH disconnects, `Read from remote host ... Operation timed out`). **ALWAYS `sudo systemctl stop ollama` BEFORE starting ComfyUI.** The `frame` startup script does this automatically.

---

## Architecture

```
┌──────────────────┐     HTTP/WebSocket    ┌──────────────────────┐
│  Mac (browser)   │ ────────────────────► │  Framestation (GPU)  │
│  Safari/Chrome   │     LAN 192.168.4.x   │  CachyOS / Linux     │
└──────────────────┘                        │                      │
                                            │  ┌────────────────┐  │
                                            │  │ Next.js :3060  │  │
                                            │  │ (FrameForge UI)│  │
                                            │  └───────┬────────┘  │
                                            │          │           │
                                            │          ▼           │
                                            │  ┌────────────────┐  │
                                            │  │ ComfyUI :8188  │  │
                                            │  │ LTX-Video 2.3  │  │
                                            │  │ (.venv Python) │  │
                                            │  └────────────────┘  │
                                            └──────────────────────┘
```

- **FrameForge (Next.js)** — this repo. Runs on port **3060**. Sends prompts to ComfyUI's REST + WS API, streams progress back to the browser, stores history locally.
- **ComfyUI** — lives on the Framestation at `/home/lynf/ComfyUI`. Runs on port **8188** inside its own Python venv at `~/ComfyUI/.venv`. Uses LTX-Video 2.3 as the generation model with Gemma 3 as the text encoder.
- **Both services run on the Framestation.** The Mac is just the browser.

---

## Environment facts (memorize these)

| Thing | Value |
|---|---|
| Machine name | Framestation (hostname `framerbox395`) |
| OS | CachyOS (Arch-based Linux) |
| LAN IP | `192.168.4.176` |
| SSH user | `lynf` |
| SSH from Mac | `ssh frame` (Mac-side SSH config alias) — or full `ssh lynf@192.168.4.176`. **Does NOT work from the Framestation itself.** |
| FrameForge project path | `/home/lynf/videostar` |
| ComfyUI path | `/home/lynf/ComfyUI` |
| **ComfyUI Python venv** | **`/home/lynf/ComfyUI/.venv`** — activate with `source ~/ComfyUI/.venv/bin/activate` |
| ComfyUI custom nodes | `/home/lynf/ComfyUI/custom_nodes` |
| tmux session names | `comfy` (ComfyUI), `frame` (Next.js) — attach with `tmux attach -t comfy` or `-t frame` |
| **Startup shortcut** | **`/usr/local/bin/frame`** — one-command launch of the whole stack. Stops Ollama, kills stale tmux, starts ComfyUI + Next.js in detached tmux sessions. Just type `frame` from any folder on the Framestation. |
| Firewall | `ufw` (NOT firewalld — CachyOS uses ufw) |
| Open ports | 8188/tcp (ComfyUI), 3060/tcp (Next.js) |
| Python inside venv | `pip` works normally once venv is activated |
| System `/usr/bin/python` | Bare — no pip, no cv2, no torch. **Do not install into system Python.** |
| Python version in venv | 3.14.3 |
| **Compute GPU** | **NVIDIA RTX PRO 4500 Blackwell**, 32623 MB VRAM (sm_120 compute capability) at PCIe `62:00.0` |
| **Display GPU** | **AMD Radeon** at PCIe `c3:00.0` — drives HDMI/DP output. NVIDIA is headless compute only. |
| NVIDIA driver | **595.58.03** (CUDA 13.2) |
| **PyTorch — REQUIRED** | **nightly cu130** (must match driver's CUDA 13.x — **NOT cu128**). Install with `pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu130`. Confirmed working: `torch 2.12.0.dev20260404+cu130`, cuda 13.0. |
| System RAM | 128 GB |
| ComfyUI version | 0.18.1 (as of 2026-04-03) |
| **Ollama** | **Also running on this box at `127.0.0.1:11434` — holds models in VRAM and is suspected of causing `cudaErrorDevicesUnavailable` crashes during ComfyUI startup. ALWAYS stop before starting ComfyUI: `sudo systemctl stop ollama`.** |

---

## URLs

| Service | URL (from Mac browser) |
|---|---|
| FrameForge (Next.js) | http://192.168.4.176:3060 |
| ComfyUI UI | http://192.168.4.176:8188 |
| ComfyUI WebSocket | ws://192.168.4.176:8188/ws |

---

## First-time setup (if starting from scratch)

**The authoritative setup script is `setup-comfyui.sh` at the repo root.** It handles Steps 1–5 below automatically. Run it on the Framestation:
```bash
cd ~/videostar && bash setup-comfyui.sh
```

> ⚠️ **The `setup-comfyui.sh` script currently pins PyTorch cu128 — this is WRONG for driver 595.58.03 / CUDA 13.2.** Before using the script, patch its PyTorch install line to use `nightly/cu130` instead of `nightly/cu128`, OR install PyTorch manually per Step 3 below and skip that part of the script.

If you're doing it manually, here's what it does:

### 1. Open the firewall (one-time)

```bash
sudo ufw allow 8188/tcp
sudo ufw allow 3060/tcp
sudo ufw reload
```

### 2. Clone and install FrameForge

```bash
cd ~
git clone https://github.com/johnfinleyproductions-lang/videostar.git
cd videostar
cp .env.example .env.local
npm install
```

### 3. Clone ComfyUI and create its Python venv

```bash
cd ~
git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI
python -m venv .venv
source .venv/bin/activate

# Check the driver's CUDA version BEFORE installing PyTorch
nvidia-smi | grep "CUDA Version"
# Example output:   Driver Version: 595.58.03      CUDA Version: 13.2
# Note the major CUDA version (13 in this case) — PyTorch wheel must match.

# PyTorch nightly — CUDA version MUST match the driver. For CUDA 13.x use cu130.
pip install --upgrade pip
pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu130

# ComfyUI core requirements
pip install -r requirements.txt

# Sanity check CUDA
python -c "import torch; print('torch:', torch.__version__); print('cuda:', torch.version.cuda); print('available:', torch.cuda.is_available()); print('device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'N/A')"
```

### 4. Install ComfyUI custom nodes (inside the venv)

**⚠️ Make sure `.venv` is activated — your prompt should show `(.venv)`.**

```bash
source ~/ComfyUI/.venv/bin/activate
cd ~/ComfyUI/custom_nodes

# LTX-Video nodes
git clone https://github.com/Lightricks/ComfyUI-LTXVideo.git
cd ComfyUI-LTXVideo && pip install -r requirements.txt && cd ..

# VideoHelperSuite (provides VHS_VideoCombine — required to output mp4)
git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git
cd ComfyUI-VideoHelperSuite && pip install -r requirements.txt && cd ..

# ComfyUI Manager (adds "Manager" button in UI for future installs)
git clone https://github.com/ltdrdata/ComfyUI-Manager.git

# MultiGPU pack — provides LTXVSequenceParallelMultiGPUPatcher
# FrameForge's workflow-builder currently injects this node unconditionally,
# so it must be installed even on single-GPU systems until we patch the builder.
# NOTE: suspected of contributing to crashes during ComfyUI startup. If the box
# crashes on ComfyUI boot, move this out as a quick test:
#   mv ~/ComfyUI/custom_nodes/ComfyUI-MultiGPU ~/ComfyUI/custom_nodes-disabled-MultiGPU
git clone https://github.com/pollockjj/ComfyUI-MultiGPU.git
cd ComfyUI-MultiGPU && [ -f requirements.txt ] && pip install -r requirements.txt; cd ..

# Verify cv2 is importable inside the venv
python -c "import cv2; print('cv2 version:', cv2.__version__)"
```

If any pip command errors on a RECORD file or half-installed package, **manually delete the broken package dir** from site-packages and reinstall clean:
```bash
cd ~/ComfyUI/.venv/lib/python3.14/site-packages
rm -rf imageio_ffmpeg imageio_ffmpeg-*.dist-info imageio_ffmpeg*.egg-info
rm -rf cv2 opencv_python opencv_python-*.dist-info opencv_python_headless opencv_python_headless-*.dist-info opencv_python*.egg-info
pip install imageio-ffmpeg==0.6.0 opencv-python-headless==4.13.0.92
```

### 5. Download LTX-Video 2.3 models

```bash
source ~/ComfyUI/.venv/bin/activate
pip install -q huggingface_hub

cd ~/ComfyUI/models/checkpoints
huggingface-cli download Lightricks/LTX-Video \
  --include "ltx-av-step-1751000_vocoder_24K.safetensors" \
  --local-dir .

cd ../clip
huggingface-cli download Kijai/LTX2.3_comfy --local-dir .
```

### 6. Clean up stray files that break Turbopack

```bash
ls -la /home/lynf/package.json /home/lynf/package-lock.json /home/lynf/node_modules 2>/dev/null
rm -f /home/lynf/package.json /home/lynf/package-lock.json
rm -rf /home/lynf/node_modules
```

### 7. Install the `frame` startup shortcut (one-time, highly recommended)

This creates a single command — `frame` — that brings up the whole stack from a cold start. Eliminates an entire class of "the terminal closed and services died" issues.

SSH into the box from the Mac (`ssh frame`), then paste this single command:

```bash
sudo tee /usr/local/bin/frame > /dev/null <<'EOF'
#!/usr/bin/env bash
# FrameForge one-shot startup
set -e
echo "→ Stopping Ollama to free GPU VRAM..."
sudo systemctl stop ollama 2>/dev/null || true
echo "→ Killing stale tmux sessions..."
tmux kill-session -t comfy 2>/dev/null || true
tmux kill-session -t frame 2>/dev/null || true
echo "→ Starting ComfyUI in tmux..."
tmux new-session -d -s comfy "cd /home/lynf/ComfyUI && source .venv/bin/activate && python main.py --listen 0.0.0.0 --port 8188; exec bash"
echo "→ Starting FrameForge (Next.js) in tmux..."
tmux new-session -d -s frame "cd /home/lynf/videostar && PORT=3060 npm run dev; exec bash"
echo ""
echo "✓ FrameForge stack started."
echo "  ComfyUI:    http://192.168.4.176:8188"
echo "  FrameForge: http://192.168.4.176:3060"
echo "  Watch:      tmux attach -t comfy   (or: -t frame)"
echo "  Detach:     Ctrl+B then d"
EOF
sudo chmod +x /usr/local/bin/frame
```

After that, any time you SSH in you can bring up the entire stack by typing:
```bash
frame
```

---

## Daily startup (normal "boot the app" flow)

### The easy way (after installing the `frame` shortcut)

```bash
ssh frame        # from your Mac
frame            # on the Framestation — brings up both services in tmux
```

Then open http://192.168.4.176:3060 on the Mac. That's it.

To watch logs: `tmux attach -t comfy` (or `-t frame`). Detach with `Ctrl+B` then `d`.

### The manual way (if `frame` isn't installed yet)

SSH in, then:

**1. Stop Ollama (frees GPU VRAM so ComfyUI can initialize CUDA cleanly):**
```bash
sudo systemctl stop ollama
```

**2. Start ComfyUI in tmux:**
```bash
tmux new -s comfy
cd ~/ComfyUI
source .venv/bin/activate
python main.py --listen 0.0.0.0 --port 8188
```

Watch the startup for:
- **No `WARNING: You need pytorch with cu130 or higher` line** — if you see it, PyTorch is wrong, stop and reinstall per Setup Step 3.
- **No Python traceback ending in `cudaErrorDevicesUnavailable`** — if you see that, something else is holding the GPU (Ollama, stale CUDA context from a previous crash, etc.).
- `To see the GUI go to: http://0.0.0.0:8188`
- Custom nodes load cleanly: `ComfyUI-VideoHelperSuite`, `ComfyUI-LTXVideo`, `ComfyUI-Manager`, `ComfyUI-MultiGPU`.

Detach with `Ctrl+B` then `d`.

**3. Start FrameForge in a separate tmux session:**
```bash
tmux new -s frame
cd ~/videostar
PORT=3060 npm run dev
```

Detach with `Ctrl+B` then `d`.

**4. Open `http://192.168.4.176:3060` on the Mac.**

### tmux cheat sheet

- `tmux new -s <name>` — create new session
- `tmux attach -t <name>` — reattach
- `tmux ls` — list sessions
- `Ctrl+B` then `d` — detach (leaves it running after SSH disconnects)
- `tmux kill-session -t <name>` — kill a session

---

## Known issues & solutions

| Symptom | Cause | Fix |
|---|---|---|
| **🔥 Framestation hard-locks (`Read from remote host ... Operation timed out` / `client_loop: send disconnect`) a few seconds after ComfyUI prints a `cudaErrorDevicesUnavailable` traceback on startup.** | **Something else is holding the NVIDIA card when ComfyUI tries to call `torch.cuda.mem_get_info()` in `comfy/model_management.py`.** Top suspects in order of likelihood: **(a) Ollama** holding models in VRAM on the same box, **(b) stale CUDA context** from a previous crashed ComfyUI that never got cleaned up, **(c) ComfyUI-MultiGPU** custom node triggering a dual-vendor (AMD+NVIDIA) device enumeration that confuses the CUDA runtime, **(d) comfy_kitchen CUDA backend** (now enabled on cu130) hitting a Blackwell FP4/FP8 op that hangs the PCIe bus. The failed `mem_get_info` call is immediately followed by a full box lockup — same network-death signature as the old cu128 crashes. | **Recovery + isolation test:** 1) Physical power cycle. 2) SSH in. 3) `sudo systemctl stop ollama` (eliminates Ollama). 4) `mv ~/ComfyUI/custom_nodes/ComfyUI-MultiGPU ~/ComfyUI/custom_nodes-disabled-MultiGPU` (eliminates MultiGPU). 5) `tmux new -s comfy && cd ~/ComfyUI && source .venv/bin/activate && python main.py --listen 0.0.0.0 --port 8188`. If ComfyUI boots cleanly → MultiGPU and/or Ollama was the culprit (FrameForge will then error on Generate with `LTXVSequenceParallelMultiGPUPatcher not found`, which is a clean app error, not a crash — next fix is patching `workflow-builder.ts`). If it still crashes → start disabling `comfy_kitchen` via env var / flag. |
| **🔥 Framestation hard-locks (SSH goes `Host is down`) the moment ComfyUI starts loading PyTorch / CUDA, with `WARNING: You need pytorch with cu130 or higher` in startup log** | **PyTorch CUDA version does not match NVIDIA driver CUDA version.** Driver is on CUDA 13.2 but PyTorch was installed as cu128. On Blackwell, this mismatch hard-hangs the GPU and cascades to the PCIe bridge `0000:61:00.0`, locking the bus. | 1) Physical power-cycle. 2) `source ~/ComfyUI/.venv/bin/activate`. 3) `pip uninstall -y torch torchvision torchaudio`. 4) `pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu130`. 5) Verify: `python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"`. This fixes the `WARNING` line but **is not sufficient on its own** — see the `cudaErrorDevicesUnavailable` row above for the currently-blocking crash. |
| `/usr/bin/python: No module named pip` | Installing into system Python instead of ComfyUI's venv | `source ~/ComfyUI/.venv/bin/activate` before running pip |
| `ModuleNotFoundError: No module named 'cv2'` (even after pip install) | Installed into wrong Python (system vs venv) | Activate venv first, THEN `pip install opencv-python-headless`, THEN re-test |
| `uninstall-no-record-file` on pip reinstall | Half-installed package from earlier system-Python attempt | Manually delete the package dir from `~/ComfyUI/.venv/lib/python3.14/site-packages/` then `pip install` clean |
| Browser timeout from Mac (`ERR_CONNECTION_TIMED_OUT`) | `ufw` blocking the port | `sudo ufw allow 3060/tcp` (or 8188), `sudo ufw reload` |
| Browser `ERR_CONNECTION_REFUSED` (not timeout) | **Service is not running.** Terminal was closed or process was killed. | SSH back in, run `frame`. Check `ss -tlnp \| grep <port>`. |
| `ssh: Could not resolve hostname frame` | You're running `ssh frame` from the Framestation itself | Skip the `ssh frame` line if already on the box |
| Next starts on port 3001 instead of 3060 | `next dev` ignores `PORT` in `.env.local` | Run as `PORT=3060 npm run dev`, or patch the `dev` script |
| `Can't resolve 'tailwindcss' in '/home/lynf'` | Stray `package.json` / lockfile in home dir | `rm -f /home/lynf/package.json /home/lynf/package-lock.json` |
| ComfyUI returns `Node 'VHS_VideoCombine' not found` | VHS Python deps not installed in venv | Activate venv, reinstall VHS requirements + `imageio-ffmpeg==0.6.0` + `opencv-python-headless` |
| ComfyUI returns `Node 'LTXVSequenceParallelMultiGPUPatcher' not found` | FrameForge's `workflow-builder.ts` injects it unconditionally | Install `pollockjj/ComfyUI-MultiGPU` — **OR** patch `workflow-builder.ts` to skip it on single-GPU systems (preferred, see TODOs) |
| `bash: pip: command not found` | Venv not activated | `source ~/ComfyUI/.venv/bin/activate` |
| `error: externally-managed-environment` | Installing into system Arch Python | Activate venv |
| CUDA not available in PyTorch | Wrong PyTorch build for the driver | Reinstall with nightly wheel matching `nvidia-smi`'s CUDA version |
| Out-of-VRAM during big jobs, or `cudaErrorDevicesUnavailable` at startup | **Ollama** holding models in VRAM | `sudo systemctl stop ollama` BEFORE starting ComfyUI |

---

## Project structure

```
videostar/
├── .env.example              # copy to .env.local
├── next.config.ts            # has allowedDevOrigins for LAN IP
├── package.json              # "dev" script — add -p 3060 for stickiness
├── setup-comfyui.sh          # authoritative one-shot setup — CURRENTLY PINS cu128, needs cu130 patch
├── docs/
│   └── GPU-TROUBLESHOOTING.md
└── src/
    ├── app/
    │   ├── api/
    │   ├── layout.tsx
    │   ├── page.tsx
    │   └── globals.css
    ├── components/
    ├── hooks/
    │   └── use-video-studio.ts
    └── lib/
        ├── comfyui-client.ts
        ├── workflow-builder.ts   # injects LTXVSequenceParallelMultiGPUPatcher unconditionally (see TODOs)
        ├── models.ts
        ├── history.ts
        └── types.ts
```

---

## Environment variables (`.env.local`)

```env
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_WS_URL=ws://127.0.0.1:8188/ws

PORT=3060
NEXT_PUBLIC_APP_URL=http://192.168.4.176:3060
NEXT_PUBLIC_COMFYUI_WS_URL=ws://192.168.4.176:8188/ws
```

> `PORT=3060` in `.env.local` does NOT set the Next dev server port. Use `PORT=3060 npm run dev` OR patch `package.json`.

---

## Tech stack

**Frontend:**
- Next.js 16.2.2 (Turbopack, App Router)
- React 19.2
- Tailwind CSS 4
- Framer Motion 12
- Sonner
- ws
- TypeScript 5

**Backend (ComfyUI side):**
- ComfyUI 0.18.1
- Python 3.14.3 (inside `~/ComfyUI/.venv`)
- **PyTorch nightly cu130** (`2.12.0.dev20260404+cu130` confirmed working — MUST match driver 595.58.03 / CUDA 13.2)
- LTX-Video 2.3 (Lightricks)
- Gemma 3 12B (Kijai's build) — text encoder
- ComfyUI-VideoHelperSuite
- ComfyUI-LTXVideo
- ComfyUI-Manager V3.39.2
- ComfyUI-MultiGPU (pollockjj) — ⚠️ currently under suspicion for crash contribution

**Hardware:**
- NVIDIA RTX PRO 4500 Blackwell, 32 GB VRAM (compute, headless) at PCIe `0000:62:00.0`
- AMD Radeon (display output) at PCIe `0000:c3:00.0`
- 128 GB system RAM

---

## Session Handoff

> **Update this section at the end of every session.**

### Status as of 2026-04-04 (end of session 5 — cu130 confirmed necessary but not sufficient)

**Working:**
- ufw firewall has 8188 and 3060 open ✓
- FrameForge (Next.js) runs on `192.168.4.176:3060` in tmux ✓
- ComfyUI custom nodes install cleanly: VideoHelperSuite, LTX-Video, Manager, MultiGPU, cv2 4.13.0, imageio-ffmpeg 0.6.0 ✓
- **PyTorch cu130 nightly is installed and the cu130 startup warning is gone.** Confirmed: `torch: 2.12.0.dev20260404+cu130`, `cuda available: True`, `device: NVIDIA RTX PRO 4500 Blackwell`, `cuda ver: 13.0` ✓
- Dual-GPU architecture documented: AMD Radeon at `c3:00.0` drives display; NVIDIA Blackwell at `62:00.0` is headless compute ✓

**⚠️ Still crashing — root cause NOT fully resolved.**

cu130 was necessary but not sufficient. After upgrading to cu130, ComfyUI now gets further into startup but still crashes the box. New crash signature:

```
File ".../comfy/model_management.py", line 242, in <module>
    _, _ = torch.cuda.mem_get_info(dev)
torch.AcceleratorError: CUDA error: CUDA-capable device(s) is/are busy or unavailable
Compile with `TORCH_USE_CUDA_DSA` to enable device-side assertions.
```

…followed a few seconds later by full SSH death (`Read from remote host 192.168.4.176: Operation timed out / Connection to 192.168.4.176 closed. / client_loop: send disconnect: Broken pipe`). Same lockup pattern as the old cu128 crashes — the Python error is just a new upstream symptom we now get to see before the lockup.

**Suspects (to be isolated next session):**
1. **Ollama** — runs on the same box (`127.0.0.1:11434`), holds models in VRAM permanently. Most likely culprit for `cudaErrorDevicesUnavailable` ("device is busy").
2. **Stale CUDA context** from a prior crashed ComfyUI that never got cleaned up (power cycle fixes this).
3. **ComfyUI-MultiGPU** — still in `custom_nodes/`. The correlation across every crash has been this node being present. Potentially confusing the CUDA runtime when it tries to enumerate two GPU vendors (AMD + NVIDIA).
4. **comfy_kitchen CUDA backend** — on cu130, ComfyUI's startup log shows `comfy_kitchen backend cuda: disabled: False` (was disabled on cu128). Could be hitting a Blackwell FP4/FP8 code path that the driver doesn't like.

**Artifacts added this session:**
- **`/usr/local/bin/frame` startup script** — one-command launch of the whole stack. Stops Ollama, kills stale tmux sessions, launches ComfyUI + Next.js in detached tmux. Documented in Setup Step 7 and Daily Startup. Installed via a `sudo tee ... <<'EOF'` heredoc so no nano editing needed.

**Current blocking issue:**
- **Framestation is DOWN** as of 2026-04-04 after this session's crash. Requires physical power cycle.

**Next action (resume here — in exact order, two variables eliminated at once):**

1. **Physical power cycle** the Framestation. Hold power button, 10s, power on.
2. From Mac: `ssh frame`.
3. **Verify GPU is back cleanly:** `nvidia-smi` — should show Blackwell at 32623 MB idle, driver 595.58.03, CUDA 13.2.
4. **Eliminate Ollama:**
   ```bash
   sudo systemctl stop ollama
   sudo systemctl status ollama   # confirm inactive (dead)
   ```
5. **Eliminate MultiGPU (park, don't delete):**
   ```bash
   mv ~/ComfyUI/custom_nodes/ComfyUI-MultiGPU ~/ComfyUI/custom_nodes-disabled-MultiGPU
   ```
6. **Install the `frame` shortcut if not already present** (Setup Step 7 — one-time). After this, future sessions start with a single `frame` command.
7. **Start ComfyUI manually this time** (so we can read the full log):
   ```bash
   tmux new -s comfy
   cd ~/ComfyUI
   source .venv/bin/activate
   python main.py --listen 0.0.0.0 --port 8188
   ```
8. **Watch the startup for the decisive outcome:**
   - **If ComfyUI reaches `To see the GUI go to: http://0.0.0.0:8188` without a crash** → Ollama and/or MultiGPU was the root cause. Start FrameForge (`tmux new -s frame && cd ~/videostar && PORT=3060 npm run dev`) and hit Generate. If Generate fails with `LTXVSequenceParallelMultiGPUPatcher not found`, that's a clean app-level error — next fix is patching `workflow-builder.ts` to skip that node (see TODOs). Then the shiba inu test becomes reachable.
   - **If the box crashes again** → Ollama + MultiGPU are NOT the cause. Next variable to eliminate is `comfy_kitchen` — investigate disabling the CUDA subbackend via env var or ComfyUI flag. Also consider `pcie_aspm=off` kernel cmdline as a PCIe-level stability knob.
9. **Either way, update this section** at the end of the session with what was learned.

**Still TODO (unchanged from session 4):**
- **Patch `setup-comfyui.sh`** to install PyTorch from `nightly/cu130` instead of `nightly/cu128`.
- **Patch `src/lib/workflow-builder.ts`** to not inject `LTXVSequenceParallelMultiGPUPatcher` when only one NVIDIA GPU is present. Preferred: query ComfyUI's `/system_stats`, count CUDA devices, skip when count == 1. This removes MultiGPU as a required dependency for single-GPU users entirely — which, if MultiGPU is the crash cause, would also be the permanent fix.
- **Patch `package.json`** `"dev"` script to `"next dev -p 3060"`.
- **Verify LTX-Video 2.3 checkpoint and Gemma 3 text encoder are present** in `~/ComfyUI/models/checkpoints` and `~/ComfyUI/models/clip`.
- **Auto-start on boot:** systemd user units for ComfyUI + FrameForge (would have saved hours this week).
- **`pcie_aspm=off` kernel cmdline** as a belt-and-suspenders PCIe power-state stability fix.
- **Pin the NVIDIA driver** to a known-good production-branch version via CachyOS package pins if crashes recur even after cu130 + Ollama-stop + MultiGPU-disable.
