# FrameForge

> **Local AI video generation studio** — a Next.js frontend that talks to a self-hosted ComfyUI backend on a GPU machine (the "Framestation") to generate video from text prompts using LTX-Video 2.3.

GitHub repo name is `videostar` for historical reasons. **The app is called FrameForge.**

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.** The sections below contain everything you need to know about the environment, paths, ports, known issues, and current status. Do not ask the user to re-explain any of this — it's all documented here. Update the [Session Handoff](#session-handoff) section at the end of every work session so the next session can pick up without going in circles.

**Top-5 gotchas that burn every session:**
1. **ComfyUI runs inside a Python venv** at `~/ComfyUI/.venv`. Always `source ~/ComfyUI/.venv/bin/activate` BEFORE any `pip` or `python -c "import ..."` command. System `/usr/bin/python` has no pip and no cv2 — anything you install there is invisible to ComfyUI.
2. **`next dev` does NOT read `PORT` from `.env.local`.** Always start FrameForge with `PORT=3060 npm run dev`, or patch the `dev` script to `"next dev -p 3060"`.
3. **No stray `package.json` in `/home/lynf/`** — it breaks Turbopack workspace detection and causes `Can't resolve 'tailwindcss'`.
4. **`ssh frame` only works from the Mac.** The alias lives in the Mac's `~/.ssh/config`. If you're already SSH'd into the Framestation, skip it — running `ssh frame` on the box itself will fail with `Could not resolve hostname frame`.
5. **Services die when their terminal closes.** Both ComfyUI and `npm run dev` are foreground processes. Close the SSH tab or Ctrl+C → the service is gone. **Always run them inside tmux** (`tmux new -s comfy` and `tmux new -s frame`) so they survive disconnects.

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
| GPU | NVIDIA RTX PRO 4500 Blackwell, 32 GB VRAM (sm_120 compute capability) — needs PyTorch nightly with CUDA 12.8 |
| System RAM | 128 GB |
| PyTorch | 2.12 nightly + cu128 |
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

# PyTorch nightly with CUDA 12.8 (required for Blackwell sm_120)
pip install --upgrade pip
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu128

# ComfyUI core requirements
pip install -r requirements.txt

# Sanity check CUDA
python -c "import torch; print('CUDA:', torch.cuda.is_available(), '-', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'N/A')"
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
python main.py --listen 0.0.0.0 --port 8188 --disable-cuda-malloc
```

Watch for:
- `To see the GUI go to: http://0.0.0.0:8188`
- The **custom nodes import section** — should show `ComfyUI-VideoHelperSuite`, `ComfyUI-LTXVideo`, `ComfyUI-Manager`, **and `ComfyUI-MultiGPU`**, each in well under a second with no red traceback.

Detach with `Ctrl+B` then `d` — ComfyUI keeps running in the background even after the SSH tab closes.

If VHS shows a red error on startup, cv2/imageio-ffmpeg is broken inside the venv — see "Known issues" below.

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
| GPU crashes / driver hang | NVIDIA DKMS module out of sync with kernel | Reboot, let DKMS rebuild on boot |
| **Framestation SSH: `Host is down`** | Box is hard-locked or powered off (kernel panic, GPU lockup, or simple shutdown) | **Physical power cycle.** After reboot, check `journalctl -b -1 -p err` and `dmesg \| tail -100` for the crash cause. Consider whether the last action before the crash was GPU-related. |
| Multiple lockfile warning in Next | See tailwindcss row | Same fix |
| CUDA not available in PyTorch | Wrong PyTorch build (not nightly cu128) or Blackwell GPU incompatibility | Reinstall PyTorch with `--index-url https://download.pytorch.org/whl/nightly/cu128` |
| Out-of-VRAM during big jobs | Ollama holding models in VRAM | Unload: `curl -s http://127.0.0.1:11434/api/generate -d '{"model":"<model-name>","keep_alive":0}'` |

---

## Project structure

```
videostar/
├── .env.example              # copy to .env.local
├── next.config.ts            # has allowedDevOrigins for LAN IP
├── package.json              # "dev" script — add -p 3060 for stickiness
├── setup-comfyui.sh          # authoritative one-shot setup (venv + torch + nodes + models + firewall)
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
- PyTorch 2.12 nightly with CUDA 12.8 (required for Blackwell sm_120 GPU)
- LTX-Video 2.3 (Lightricks) — main video generation model
- Gemma 3 12B (Kijai's ComfyUI-compatible version) — text encoder
- ComfyUI-VideoHelperSuite — provides `VHS_VideoCombine` node for mp4 output
- ComfyUI-LTXVideo — LTX nodes
- ComfyUI-Manager V3.39.2 — UI-based custom node installer
- ComfyUI-MultiGPU (pollockjj) — provides `LTXVSequenceParallelMultiGPUPatcher` required by FrameForge's workflow builder

---

## Session Handoff

> **Update this section at the end of every session** so the next one can pick up cleanly. Short, factual, dated.

### Status as of 2026-04-04 (end of session 3)

**Working:**
- ufw firewall has 8188 and 3060 open ✓
- FrameForge (Next.js) on `192.168.4.176:3060`, loads in Mac browser ✓
- FrameForge successfully POSTs to `/api/generate` and reaches ComfyUI when both are up ✓
- ComfyUI running in venv with all custom nodes loading cleanly at import time:
  - `ComfyUI-VideoHelperSuite` (0.2s) — **VHS_VideoCombine blocker resolved** ✓
  - `ComfyUI-LTXVideo` (0.1s) ✓
  - `ComfyUI-Manager` V3.39.2 (0.1s) ✓
  - `websocket_image_save.py` (0.0s) ✓
- `cv2 4.13.0` + `imageio-ffmpeg 0.6.0` installed cleanly inside `~/ComfyUI/.venv` (after manually deleting the broken package dirs from site-packages)
- Comprehensive README with all session learnings committed to repo ✓

**What we learned this session:**
- **VHS deps fix:** `pip install --force-reinstall` can't recover from a package with no RECORD file. The only fix is to manually `rm -rf` the broken dir in `site-packages/` and do a clean `pip install` afterwards. Documented in Setup Step 4.
- **`ssh frame` is Mac-only:** The alias is in the Mac's `~/.ssh/config`. Running it from the Framestation gives `Could not resolve hostname frame` — just skip it when already on the box.
- **Closing an SSH tab kills the service.** Both ComfyUI and `npm run dev` are foreground processes. We lost FrameForge mid-session this way. **Fix:** always launch inside tmux (`tmux new -s comfy` / `tmux new -s frame`), detach with `Ctrl+B d`, reattach with `tmux attach -t <name>`.
- **Connection errors tell you which problem it is:**
  - `ERR_CONNECTION_REFUSED` = service not running (not a firewall issue)
  - `ERR_CONNECTION_TIMED_OUT` = firewall blocking
  - `Host is down` = the box itself is offline
- **FrameForge's `workflow-builder.ts` injects `LTXVSequenceParallelMultiGPUPatcher` unconditionally**, even on single-GPU boxes. That node comes from `pollockjj/ComfyUI-MultiGPU`, not from `ComfyUI-LTXVideo`. Until we patch the builder, the MultiGPU pack must be installed.

**Current blocking issue:**
- **Framestation is DOWN.** SSH reports `ssh: connect to host 192.168.4.176 port 22: Host is down`. The box hard-locked shortly after we attempted to install `ComfyUI-MultiGPU` and restart ComfyUI. Unclear whether the crash was related (GPU/driver hang triggered by the new node pack, or kernel panic) or coincidental. **Requires physical power cycle before any further work.**

**Next action (resume here — in exact order):**

1. **Physically power-cycle the Framestation.** Hold the power button until it shuts off, wait 10 seconds, power back on.
2. From the Mac, confirm it's back: `ping 192.168.4.176`, then `ssh frame`.
3. **Diagnose the crash** (do this before launching anything GPU-heavy):
   ```bash
   journalctl -b -1 -p err --no-pager | tail -100   # errors from the previous boot
   dmesg | tail -100                                  # recent kernel messages
   nvidia-smi                                         # confirm GPU is alive and driver loaded
   ```
   Look for NVIDIA/Xid errors, OOM kills, or kernel panics. Paste output into the next Claude session.
4. **Start both services in tmux** (not bare terminals this time):
   ```bash
   # ComfyUI
   tmux new -s comfy
   source ~/ComfyUI/.venv/bin/activate
   cd ~/ComfyUI
   python main.py --listen 0.0.0.0 --port 8188 --disable-cuda-malloc
   # Ctrl+B d to detach

   # Next.js
   tmux new -s frame
   cd ~/videostar
   PORT=3060 npm run dev
   # Ctrl+B d to detach
   ```
5. **Confirm `ComfyUI-MultiGPU` actually installed and loads.** Check the custom-nodes import section of the ComfyUI startup output (`tmux attach -t comfy` to view). If the folder isn't in `~/ComfyUI/custom_nodes/ComfyUI-MultiGPU`, install it:
   ```bash
   source ~/ComfyUI/.venv/bin/activate
   cd ~/ComfyUI/custom_nodes
   git clone https://github.com/pollockjj/ComfyUI-MultiGPU
   cd ComfyUI-MultiGPU
   [ -f requirements.txt ] && pip install -r requirements.txt
   # restart ComfyUI in its tmux window
   ```
6. **Retry the shiba inu prompt** at http://192.168.4.176:3060. Watch the ComfyUI tmux window for sampler progress and the final `VHS_VideoCombine` writing an mp4 to `~/ComfyUI/output/`.
7. **First successful end-to-end video = this phase is done.** Update this section with the win.

**Still TODO (after first successful generation):**
- **Patch `src/lib/workflow-builder.ts`** to not inject `LTXVSequenceParallelMultiGPUPatcher` when only one GPU is present. Preferred approach: call ComfyUI's `/system_stats` endpoint, check GPU count, and skip the node when `== 1`. Secondary option: add a UI toggle (off by default). This is the **correct long-term fix** — it removes an unnecessary custom-node dependency for single-GPU users.
- **Patch `package.json`** `"dev"` script from `"next dev"` to `"next dev -p 3060"` so `PORT=3060` prefix isn't needed every time.
- **Verify LTX-Video 2.3 checkpoint and Gemma 3 text encoder are present:**
  ```bash
  ls -la ~/ComfyUI/models/checkpoints
  ls -la ~/ComfyUI/models/clip
  ```
  If missing, re-run `bash ~/videostar/setup-comfyui.sh` or the `huggingface-cli download` commands from Setup Step 5.
- **Auto-start on boot:** write systemd user units for ComfyUI and FrameForge so they come up automatically after a reboot (would have saved this session's crash recovery pain).
- **Investigate the crash.** If `journalctl` shows an NVIDIA/Xid error or GPU hang, we may need to pin a specific driver version or change startup flags. If it was a VRAM exhaustion, consider Ollama unload-on-demand.
- Consider a `npm run start:all` script that launches both tmux sessions in one command.
