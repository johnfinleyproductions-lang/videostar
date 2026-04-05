# FrameForge

> **Local AI video generation studio** — a Next.js frontend that talks to a self-hosted ComfyUI backend on a GPU machine (the "Framestation") to generate video from text prompts using LTX-Video 2.3.

GitHub repo name is `videostar` for historical reasons. **The app is called FrameForge.**

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.** The sections below contain everything you need to know about the environment, paths, ports, known issues, and current status. Do not ask the user to re-explain any of this — it's all documented here. Update the [Session Handoff](#session-handoff) section at the end of every work session so the next session can pick up without going in circles.

**Top-6 gotchas that burn every session:**
1. **ComfyUI runs inside a Python venv** at `~/ComfyUI/.venv`. Always `source ~/ComfyUI/.venv/bin/activate` BEFORE any `pip` or `python -c "import ..."` command. System `/usr/bin/python` has no pip and no cv2 — anything you install there is invisible to ComfyUI.
2. **`next dev` does NOT read `PORT` from `.env.local`.** Always start FrameForge with `PORT=3060 npm run dev`, or patch the `dev` script to `"next dev -p 3060"`.
3. **No stray `package.json` in `/home/lynf/`** — it breaks Turbopack workspace detection and causes `Can't resolve 'tailwindcss'`.
4. **`ssh frame` only works from the Mac.** The alias lives in the Mac's `~/.ssh/config`. If you're already SSH'd into the Framestation, skip it — running `ssh frame` on the box itself will fail with `Could not resolve hostname frame`.
5. **Services die when their terminal closes.** Both ComfyUI and `npm run dev` are foreground processes. Close the SSH tab or Ctrl+C → the service is gone. **Always run them inside tmux** (`tmux new -s comfy` and `tmux new -s frame`) so they survive disconnects.
6. **🔥 PyTorch CUDA version MUST match the NVIDIA driver CUDA version.** If ComfyUI prints `WARNING: You need pytorch with cu130 or higher to use optimized CUDA operations` at startup, **stop immediately — do not proceed**. On Blackwell silicon, this mismatch causes a hard GPU lockup that cascades into a PCIe bus hang and takes the whole box down (manifests as `ssh: Host is down`). Run `nvidia-smi` to see the driver's CUDA version, then reinstall PyTorch from the matching nightly wheel (e.g. `--index-url https://download.pytorch.org/whl/nightly/cu130` if driver shows CUDA 13.x). See "Known issues" row **"Framestation crashes when ComfyUI starts"** for the full procedure.

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
| Firewall | `ufw` (NOT firewalld — CachyOS uses ufw) |
| Open ports | 8188/tcp (ComfyUI), 3060/tcp (Next.js) |
| Python inside venv | `pip` works normally once venv is activated |
| System `/usr/bin/python` | Bare — no pip, no cv2, no torch. **Do not install into system Python.** |
| Python version in venv | 3.14.3 |
| **Compute GPU** | **NVIDIA RTX PRO 4500 Blackwell**, 32623 MB VRAM (sm_120 compute capability) at PCIe `62:00.0` |
| **Display GPU** | **AMD Radeon** at PCIe `c3:00.0` — drives HDMI/DP output. NVIDIA is headless compute only. |
| NVIDIA driver | **595.58.03** (CUDA 13.2) |
| **PyTorch — REQUIRED** | **nightly cu130** (must match driver's CUDA 13.x — **NOT cu128**). Install with `pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu130` |
| System RAM | 128 GB |
| ComfyUI version | 0.18.1 (as of 2026-04-03) |
| Ollama | Also running on this box at `127.0.0.1:11434` (often holds models in VRAM — may need unload before big jobs) |

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
# Installing the wrong version (e.g. cu128 with a CUDA-13 driver) on Blackwell
# will HARD-LOCK THE BOX the moment ComfyUI tries to initialize CUDA.
pip install --upgrade pip
pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu130

# ComfyUI core requirements
pip install -r requirements.txt

# Sanity check CUDA — this MUST succeed without hanging. If it hangs, power-cycle
# and verify you installed the wheel matching nvidia-smi's CUDA version.
python -c "import torch; print('torch:', torch.__version__); print('cuda:', torch.version.cuda); print('available:', torch.cuda.is_available()); print('device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'N/A')"
```

### 4. Install ComfyUI custom nodes (inside the venv)

**⚠️ Make sure `.venv` is activated — your prompt should show `(.venv)`.**

```bash
source ~/ComfyUI/.venv/bin/activate   # if not already active
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
# (FrameForge's workflow-builder currently injects this node unconditionally,
#  so it must be installed even on single-GPU systems until we patch the builder)
git clone https://github.com/pollockjj/ComfyUI-MultiGPU.git
cd ComfyUI-MultiGPU && [ -f requirements.txt ] && pip install -r requirements.txt; cd ..

# Verify cv2 is importable inside the venv (this is the critical test)
python -c "import cv2; print('cv2 version:', cv2.__version__)"
```

If any pip command errors on a RECORD file or half-installed package, **manually delete the broken package dir** from site-packages and reinstall clean (the `--force-reinstall` flag is not enough because pip still tries to uninstall first):
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

Turbopack auto-detects the "workspace root" by looking for `package.json` / `package-lock.json` upward from the project folder. A stray one in `/home/lynf/` will cause `Can't resolve 'tailwindcss'` errors. Make sure `/home/lynf/` is clean:

```bash
ls -la /home/lynf/package.json /home/lynf/package-lock.json /home/lynf/node_modules 2>/dev/null
# If any of those exist, remove them:
rm -f /home/lynf/package.json /home/lynf/package-lock.json
rm -rf /home/lynf/node_modules
```

---

## Daily startup (normal "boot the app" flow)

SSH into the Framestation from your Mac:

```bash
ssh frame   # or full: ssh lynf@192.168.4.176
```

### 1. Start ComfyUI (in a tmux session, inside the venv)

```bash
tmux new -s comfy          # or: tmux attach -t comfy  if session already exists
cd ~/ComfyUI
source .venv/bin/activate
python main.py --listen 0.0.0.0 --port 8188
```

> **Do NOT pass `--disable-cuda-malloc`** on the Blackwell card. That flag was an older Ampere-era workaround and has been associated with instability on Blackwell + recent NVIDIA drivers. Previous sessions used it and hit crashes.

Watch the startup output for:
- **No `WARNING: You need pytorch with cu130 or higher` line** — if you see that, STOP, power-cycle, and fix PyTorch (see "Known issues" row for the full procedure). Do not let it proceed — the next log line will hang the box.
- `To see the GUI go to: http://0.0.0.0:8188`
- The **custom nodes import section** — should show `ComfyUI-VideoHelperSuite`, `ComfyUI-LTXVideo`, `ComfyUI-Manager`, **and `ComfyUI-MultiGPU`**, each in well under a second with no red traceback.

Detach with `Ctrl+B` then `d` — ComfyUI keeps running in the background even after the SSH tab closes.

### 2. Start FrameForge (in a separate tmux session)

```bash
tmux new -s frame          # or: tmux attach -t frame
cd ~/videostar
PORT=3060 npm run dev
```

> **Important:** `next dev` does NOT read `PORT` from `.env.local`. You must prefix the command with `PORT=3060` every time, OR update `package.json` `"dev"` script to `"next dev -p 3060"` (recommended — see TODOs).

Expected output:
```
Next.js 16.2.2 (Turbopack)
- Local:    http://localhost:3060
- Network:  http://192.168.4.176:3060
- Environments: .env.local
Ready in ~200ms
```

Detach with `Ctrl+B` then `d`.

### 3. Open in Mac browser

```
http://192.168.4.176:3060
```

### tmux cheat sheet

- `tmux new -s <name>` — create new session (`comfy` for ComfyUI, `frame` for Next.js)
- `tmux attach -t <name>` — reattach to a session
- `tmux ls` — list all sessions
- `Ctrl+B` then `d` — detach from current session (leaves it running after SSH disconnects)
- `Ctrl+B` then `c` — create a new window inside the current session
- `Ctrl+B` then `0` / `1` / `2` — switch to window 0/1/2
- `Ctrl+B` then `n` / `p` — next / previous window

---

## Known issues & solutions

| Symptom | Cause | Fix |
|---|---|---|
| **🔥 Framestation hard-locks (SSH goes `Host is down`) the moment ComfyUI starts loading PyTorch / CUDA** | **PyTorch CUDA version does not match NVIDIA driver CUDA version.** Driver is on CUDA 13.2 but PyTorch was installed as cu128 (CUDA 12.8). When ComfyUI initializes a CUDA context, the version gap against the driver ABI causes a hard GPU hang on the Blackwell card, which cascades into the PCIe bridge at `0000:61:00.0` (parent of the NVIDIA card at `0000:62:00.0`), which locks the whole bus and takes the box down. **This is a reproducible crash, not a flaky driver.** Evidence: ComfyUI prints `WARNING: You need pytorch with cu130 or higher to use optimized CUDA operations` in the startup log before the hang. The `pcieport 0000:61:00.0: Unable to change power state from D0 to D3hot, device inaccessible` line in `journalctl -b -1 -p err` is the PCIe cascade symptom, not the cause. | **1)** Physically power-cycle the box. **2)** SSH back in. **3)** `source ~/ComfyUI/.venv/bin/activate`. **4)** Confirm the mismatch: `nvidia-smi \| grep "CUDA Version"` and `python -c "import torch; print(torch.version.cuda)"`. **5)** Reinstall PyTorch matching the driver: `pip uninstall -y torch torchvision torchaudio && pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu130`. **6)** Verify without crashing: `python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"`. If that prints `True NVIDIA RTX PRO 4500 Blackwell` without hanging, the fix worked. **7)** Start ComfyUI in tmux without `--disable-cuda-malloc`. |
| `/usr/bin/python: No module named pip` | Installing into system Python instead of ComfyUI's venv | `source ~/ComfyUI/.venv/bin/activate` before running pip |
| `ModuleNotFoundError: No module named 'cv2'` (even after pip install) | Installed into wrong Python (system vs venv) | Activate venv first, THEN `pip install opencv-python-headless`, THEN re-test with `python -c "import cv2"` |
| `uninstall-no-record-file` on pip reinstall | Half-installed package from earlier system-Python attempt has no RECORD file, and `--force-reinstall` still tries to uninstall first | Manually delete the package dir from `~/ComfyUI/.venv/lib/python3.14/site-packages/` then `pip install` clean. See Setup Step 4 for the exact commands. |
| Browser timeout from Mac (`ERR_CONNECTION_TIMED_OUT`) | `ufw` blocking the port | `sudo ufw allow 3060/tcp` (or 8188), `sudo ufw reload` |
| Browser `ERR_CONNECTION_REFUSED` (not timeout) | **Service is not running.** Terminal was closed or process was killed. Firewall is fine. | SSH back in, restart ComfyUI / Next.js. Check `ss -tlnp \| grep <port>` to confirm nothing is listening. **Run services in tmux to prevent this.** |
| `ssh: Could not resolve hostname frame` | You're running `ssh frame` from the Framestation itself. The alias only exists in the Mac's `~/.ssh/config`. | If you're already on the box, skip the `ssh frame` line. |
| Next starts on port 3001 instead of 3060 | `next dev` ignores `PORT` in `.env.local` | Run as `PORT=3060 npm run dev`, or patch the `dev` script |
| `Can't resolve 'tailwindcss' in '/home/lynf'` | Stray `package.json` / lockfile in home dir confuses Turbopack workspace detection | `rm -f /home/lynf/package.json /home/lynf/package-lock.json` then clear `.next` cache |
| `Port 3000 is in use by an unknown process` | Something else is on 3000 on the box (possibly Ollama or a leftover dev server) | Not our problem — we want 3060, use `PORT=3060` |
| ComfyUI returns `Node 'VHS_VideoCombine' not found` | VHS folder present but Python deps not installed in venv | Activate venv, then `pip install -r custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt` and reinstall `imageio-ffmpeg==0.6.0` + `opencv-python-headless` (see Setup Step 4 if RECORD errors happen) |
| ComfyUI returns `Node 'LTXVSequenceParallelMultiGPUPatcher' not found` | FrameForge's `src/lib/workflow-builder.ts` injects this multi-GPU node unconditionally, but `ComfyUI-MultiGPU` pack is not installed | Install `pollockjj/ComfyUI-MultiGPU` into `custom_nodes/` (see Setup Step 4) — **OR** patch `workflow-builder.ts` to skip the node on single-GPU systems (preferred long-term fix, see TODOs) |
| `bash: pip: command not found` | Venv not activated (and system has no pip either) | `source ~/ComfyUI/.venv/bin/activate` |
| `error: externally-managed-environment` | Installing into system Arch Python (not the venv) | Activate venv. Inside venv, this error doesn't happen. Only outside the venv, as a last resort, append `--break-system-packages` |
| `WARNING: You need pytorch with cu130 or higher to use optimized CUDA operations` | PyTorch CUDA version < driver CUDA version | **This is the crash warning — do not ignore.** See the first row of this table for the full fix. |
| Multiple lockfile warning in Next | See tailwindcss row | Same fix |
| CUDA not available in PyTorch | Wrong PyTorch build or Blackwell GPU incompatibility | Reinstall PyTorch with the nightly wheel matching `nvidia-smi`'s CUDA version (currently `cu130`) |
| Out-of-VRAM during big jobs | Ollama holding models in VRAM | Unload: `curl -s http://127.0.0.1:11434/api/generate -d '{"model":"<model-name>","keep_alive":0}'` |

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
    │   ├── api/              # route handlers (generate, history, etc.)
    │   ├── layout.tsx
    │   ├── page.tsx
    │   └── globals.css
    ├── components/           # React UI
    ├── hooks/
    │   └── use-video-studio.ts   # main generate/history hook
    └── lib/
        ├── comfyui-client.ts     # REST + WS client for ComfyUI
        ├── workflow-builder.ts   # builds ComfyUI workflow JSON — currently injects LTXVSequenceParallelMultiGPUPatcher unconditionally (see TODOs)
        ├── models.ts
        ├── history.ts
        └── types.ts
```

---

## Environment variables (`.env.local`)

```env
# ComfyUI backend — always use 127.0.0.1, NEVER localhost (IPv6 issue on CachyOS)
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_WS_URL=ws://127.0.0.1:8188/ws

# App
PORT=3060
NEXT_PUBLIC_APP_URL=http://192.168.4.176:3060
NEXT_PUBLIC_COMFYUI_WS_URL=ws://192.168.4.176:8188/ws
```

> Note: `PORT=3060` in `.env.local` does NOT set the Next dev server port (Next dev reads `PORT` only from the shell env). Use `PORT=3060 npm run dev` OR patch `package.json`.

---

## Tech stack

**Frontend (this repo):**
- Next.js 16.2.2 (Turbopack dev, App Router)
- React 19.2
- Tailwind CSS 4
- Framer Motion 12
- Sonner (toasts)
- ws (WebSocket client to ComfyUI)
- TypeScript 5

**Backend (ComfyUI side):**
- ComfyUI 0.18.1 (from `comfyanonymous/ComfyUI`)
- Python 3.14.3 (inside `~/ComfyUI/.venv`)
- **PyTorch nightly cu130** (MUST match NVIDIA driver 595.58.03 / CUDA 13.2 — NOT cu128)
- LTX-Video 2.3 (Lightricks) — main video generation model
- Gemma 3 12B (Kijai's ComfyUI-compatible version) — text encoder
- ComfyUI-VideoHelperSuite — provides `VHS_VideoCombine` node for mp4 output
- ComfyUI-LTXVideo — LTX nodes
- ComfyUI-Manager V3.39.2 — UI-based custom node installer
- ComfyUI-MultiGPU (pollockjj) — provides `LTXVSequenceParallelMultiGPUPatcher` required by FrameForge's workflow builder

**Hardware:**
- NVIDIA RTX PRO 4500 Blackwell, 32 GB VRAM (compute, headless) at PCIe `0000:62:00.0`
- AMD Radeon (display output) at PCIe `0000:c3:00.0`
- 128 GB system RAM

---

## Session Handoff

> **Update this section at the end of every session** so the next one can pick up cleanly. Short, factual, dated.

### Status as of 2026-04-04 (end of session 4 — root cause identified)

**Working:**
- ufw firewall has 8188 and 3060 open ✓
- FrameForge (Next.js) runs on `192.168.4.176:3060` in tmux, loads in Mac browser ✓
- FrameForge successfully POSTs to `/api/generate` and reaches ComfyUI when both are up ✓
- ComfyUI custom nodes install cleanly in the venv: VideoHelperSuite, LTX-Video, Manager, MultiGPU, cv2 4.13.0, imageio-ffmpeg 0.6.0 ✓
- NVIDIA RTX PRO 4500 Blackwell is physically healthy — `nvidia-smi` reports 32623 MB VRAM free, 19 °C idle, driver 595.58.03 + CUDA 13.2, no errors ✓
- Discovered dual-GPU architecture: AMD Radeon at `c3:00.0` drives display; NVIDIA Blackwell at `62:00.0` is headless compute ✓

**🎯 Root cause of both crashes identified (SESSION 4 BREAKTHROUGH):**

Both "Host is down" crashes had the **same root cause**: **PyTorch cu128 (CUDA 12.8) is incompatible with NVIDIA driver 595.58.03 (CUDA 13.2) on Blackwell silicon.**

Evidence chain:
1. ComfyUI startup explicitly warns: `WARNING: You need pytorch with cu130 or higher to use optimized CUDA operations`
2. Both crashes happened *exactly* when ComfyUI was loading PyTorch / initializing CUDA — never before, never at idle
3. `journalctl -b -1 -p err` on crash #1 showed `pcieport 0000:61:00.0: Unable to change power state from D0 to D3hot, device inaccessible`. Bridge `61:00.0` is the direct PCIe parent of the NVIDIA card at `62:00.0`. The GPU hung during CUDA init, which locked its PCIe link, which cascaded up the bridge, which took the bus down.
4. `nvidia-smi` always works post-reboot because it talks to the kernel module directly, bypassing CUDA runtime. So the GPU itself is fine — only the CUDA runtime interface is poisoned.

**This is a reproducible bug, not flaky hardware.** Every session that tried to start ComfyUI with cu128 PyTorch would crash the box. Previous sessions missed this because we were chasing downstream symptoms (VHS, MultiGPU, etc.) without reading the startup warning.

**Current blocking issue:**
- **Framestation is DOWN again** as of 2026-04-04 ~20:45 UTC after this session's second crash attempt. Requires physical power cycle. Root cause is now known — cu128/cu130 mismatch — so the recovery plan is deterministic.

**Next action (resume here — in exact order, do not skip steps):**

1. **Physically power-cycle the Framestation.** Hold power button, wait 10s, power on.
2. From Mac: `ssh frame`.
3. **Verify the GPU came back cleanly:**
   ```bash
   nvidia-smi
   ```
   Should show the Blackwell card at 32623 MB, idle, driver 595.58.03, CUDA 13.2. If `nvidia-smi` hangs or reports no devices, stop and `sudo dkms autoinstall && sudo reboot`.
4. **Activate the venv and confirm the cu128 vs cu130 mismatch:**
   ```bash
   source ~/ComfyUI/.venv/bin/activate
   python -c "import torch; print('torch:', torch.__version__); print('torch.cuda:', torch.version.cuda)"
   ```
   You should see `torch.cuda: 12.8` — that's the bug. **Do NOT call `torch.cuda.is_available()` yet** — that's the call that will trigger the crash if we haven't fixed PyTorch first.
5. **Replace PyTorch with the cu130 nightly:**
   ```bash
   pip uninstall -y torch torchvision torchaudio
   pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu130
   ```
6. **The critical test — this is the moment of truth:**
   ```bash
   python -c "import torch; print('torch:', torch.__version__); print('cuda ver:', torch.version.cuda); print('available:', torch.cuda.is_available()); print('device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'N/A')"
   ```
   Expected: `torch: 2.13.0.dev...+cu130`, `cuda ver: 13.0` (or higher), `available: True`, `device: NVIDIA RTX PRO 4500 Blackwell`. **If this command returns without hanging SSH, the crash is fixed forever.** If SSH dies, we have a deeper problem and need a different strategy (downgrade driver, or disable PCIe ASPM via kernel cmdline).
7. **Start ComfyUI in tmux** (note: no `--disable-cuda-malloc` this time):
   ```bash
   tmux new -s comfy
   cd ~/ComfyUI
   source .venv/bin/activate
   python main.py --listen 0.0.0.0 --port 8188
   ```
   Watch the startup. **The `WARNING: You need pytorch with cu130 or higher` line should now be GONE.** Wait for `To see the GUI go to: http://0.0.0.0:8188`, confirm all four custom nodes load cleanly, then `Ctrl+B d` to detach.
8. **Start FrameForge in tmux:**
   ```bash
   tmux new -s frame
   cd ~/videostar
   PORT=3060 npm run dev
   # Ctrl+B d
   ```
9. **Reload http://192.168.4.176:3060 on the Mac, paste the shiba inu prompt, click Generate.** Watch `tmux attach -t comfy` for sampler progress.
10. **First successful end-to-end video = this phase is done.** Update this section with the win and move on to TODOs below.

**Still TODO (after first successful generation):**
- **Patch `setup-comfyui.sh`** to install PyTorch from `nightly/cu130` instead of `nightly/cu128`. This was the root cause of two crashes — fix it at the source so no future session can re-introduce it.
- **Patch `src/lib/workflow-builder.ts`** to not inject `LTXVSequenceParallelMultiGPUPatcher` when only one NVIDIA GPU is present. Preferred: query ComfyUI's `/system_stats` endpoint, count CUDA devices, skip the node when count == 1. This removes an unnecessary custom-node dependency for single-NVIDIA-GPU users (which is everyone so far).
- **Patch `package.json`** `"dev"` script from `"next dev"` to `"next dev -p 3060"` so `PORT=3060` prefix isn't needed every time.
- **Verify LTX-Video 2.3 checkpoint and Gemma 3 text encoder are present:**
  ```bash
  ls -la ~/ComfyUI/models/checkpoints
  ls -la ~/ComfyUI/models/clip
  ```
  If missing, re-run the `huggingface-cli download` commands from Setup Step 5 (do NOT re-run `setup-comfyui.sh` until its PyTorch line is patched).
- **Auto-start on boot:** write systemd user units for ComfyUI and FrameForge so they come up automatically after a reboot (would have saved two full rounds of crash recovery pain this week).
- **Explore disabling PCIe ASPM as a belt-and-suspenders fix.** Even with cu130 matching the driver, the PCIe bridge at `61:00.0` was clearly willing to D3-sleep the NVIDIA card. If we ever see another `Unable to change power state` in dmesg, add `pcie_aspm=off` to the kernel command line in `/etc/default/grub` and run `grub-mkconfig -o /boot/grub/grub.cfg`.
- **Pin the driver.** 595.58.03 is very new. If future crashes recur, consider pinning to a known-good production-branch NVIDIA driver via CachyOS package pins.
- Consider a `npm run start:all` script that launches both tmux sessions in one command.
