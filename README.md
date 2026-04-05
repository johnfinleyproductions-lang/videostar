# FrameForge

> **Local AI video generation studio** — a Next.js frontend that talks to a self-hosted ComfyUI backend on a GPU machine (the "Framestation") to generate video from text prompts using LTX-Video 2.3.

GitHub repo name is `videostar` for historical reasons. **The app is called FrameForge.**

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.** The sections below contain everything you need to know about the environment, paths, ports, known issues, and current status. Do not ask the user to re-explain any of this — it's all documented here. Update the [Session Handoff](#session-handoff) section at the end of every work session so the next session can pick up without going in circles.

**Top-3 gotchas that burn every session:**
1. **ComfyUI runs inside a Python venv** at `~/ComfyUI/.venv`. Always `source ~/ComfyUI/.venv/bin/activate` BEFORE any `pip` or `python -c "import ..."` command. System `/usr/bin/python` has no pip and no cv2 — anything you install there is invisible to ComfyUI.
2. **`next dev` does NOT read `PORT` from `.env.local`.** Always start FrameForge with `PORT=3060 npm run dev`, or patch the `dev` script to `"next dev -p 3060"`.
3. **No stray `package.json` in `/home/lynf/`** — it breaks Turbopack workspace detection and causes `Can't resolve 'tailwindcss'`.

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
| SSH from Mac | `ssh frame` (SSH config alias) — or full `ssh lynf@192.168.4.176` |
| FrameForge project path | `/home/lynf/videostar` |
| ComfyUI path | `/home/lynf/ComfyUI` |
| **ComfyUI Python venv** | **`/home/lynf/ComfyUI/.venv`** — activate with `source ~/ComfyUI/.venv/bin/activate` |
| ComfyUI custom nodes | `/home/lynf/ComfyUI/custom_nodes` |
| tmux session name | `frame` (attach with `tmux attach -t frame`) |
| Firewall | `ufw` (NOT firewalld — CachyOS uses ufw) |
| Open ports | 8188/tcp (ComfyUI), 3060/tcp (Next.js) |
| Python inside venv | `pip` works normally once venv is activated |
| System `/usr/bin/python` | Bare — no pip, no cv2, no torch. **Do not install into system Python.** |
| GPU | NVIDIA Blackwell (sm_120 compute capability) — needs PyTorch nightly with CUDA 12.8 |
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

# Verify cv2 is importable inside the venv (this is the critical test)
python -c "import cv2; print('cv2 version:', cv2.__version__)"
```

If any pip command errors on a RECORD file or half-installed package:
```bash
pip install --force-reinstall --no-deps imageio-ffmpeg==0.6.0
pip install --force-reinstall opencv-python-headless
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

### 1. Start ComfyUI (in tmux, inside the venv)

```bash
tmux attach -t frame   # reattach if session exists; `tmux new -s frame` if not
cd ~/ComfyUI
source .venv/bin/activate
python main.py --listen 0.0.0.0 --port 8188 --disable-cuda-malloc
```

Watch for:
- `To see the GUI go to: http://0.0.0.0:8188`
- `Loaded X custom nodes` — should mention `ComfyUI-VideoHelperSuite`, `ComfyUI-LTXVideo`, and `ComfyUI-Manager`

If VHS shows a red error on startup, cv2/imageio-ffmpeg is broken inside the venv — see "Known issues" below.

### 2. Start FrameForge (in a new tmux window)

In the same tmux session, press `Ctrl+B` then `c` to create a new window, then:

```bash
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

### 3. Open in Mac browser

```
http://192.168.4.176:3060
```

### tmux cheat sheet

- `Ctrl+B` then `c` — create new window (keeps current one running)
- `Ctrl+B` then `0` / `1` / `2` — switch to window 0/1/2
- `Ctrl+B` then `n` / `p` — next / previous window
- `Ctrl+B` then `d` — detach from session (leaves everything running after SSH disconnects)
- `tmux attach -t frame` — reattach to the `frame` session
- `tmux ls` — list all sessions

---

## Known issues & solutions

| Symptom | Cause | Fix |
|---|---|---|
| `/usr/bin/python: No module named pip` | Installing into system Python instead of ComfyUI's venv | `source ~/ComfyUI/.venv/bin/activate` before running pip |
| `ModuleNotFoundError: No module named 'cv2'` (even after pip install) | Installed into wrong Python (system vs venv) | Activate venv first, THEN `pip install opencv-python-headless`, THEN re-test with `python -c "import cv2"` |
| Browser timeout from Mac (`ERR_CONNECTION_TIMED_OUT`) | `ufw` blocking the port | `sudo ufw allow 3060/tcp` (or 8188), `sudo ufw reload` |
| Next starts on port 3001 instead of 3060 | `next dev` ignores `PORT` in `.env.local` | Run as `PORT=3060 npm run dev`, or patch the `dev` script |
| `Can't resolve 'tailwindcss' in '/home/lynf'` | Stray `package.json` / lockfile in home dir confuses Turbopack workspace detection | `rm -f /home/lynf/package.json /home/lynf/package-lock.json` then clear `.next` cache |
| `Port 3000 is in use by an unknown process` | Something else is on 3000 on the box (possibly Ollama or a leftover dev server) | Not our problem — we want 3060, use `PORT=3060` |
| ComfyUI returns `Node 'VHS_VideoCombine' not found` | VHS folder present but Python deps not installed in venv | Activate venv, then `pip install -r custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt` and reinstall `imageio-ffmpeg==0.6.0` + `opencv-python-headless` with `--force-reinstall` |
| `bash: pip: command not found` | Venv not activated (and system has no pip either) | `source ~/ComfyUI/.venv/bin/activate` |
| `error: externally-managed-environment` | Installing into system Arch Python (not the venv) | Activate venv. Inside venv, this error doesn't happen. Only outside the venv, as a last resort, append `--break-system-packages` |
| GPU crashes / driver hang | NVIDIA DKMS module out of sync with kernel | Reboot, let DKMS rebuild on boot |
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
        ├── workflow-builder.ts   # builds ComfyUI workflow JSON
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
- ComfyUI (latest from `comfyanonymous/ComfyUI`)
- PyTorch nightly with CUDA 12.8 (required for Blackwell sm_120 GPU)
- LTX-Video 2.3 (Lightricks) — main video generation model
- Gemma 3 12B (Kijai's ComfyUI-compatible version) — text encoder
- ComfyUI-VideoHelperSuite — provides `VHS_VideoCombine` node for mp4 output
- ComfyUI-LTXVideo — LTX nodes
- ComfyUI-Manager — UI-based custom node installer

---

## Session Handoff

> **Update this section at the end of every session** so the next one can pick up cleanly. Short, factual, dated.

### Status as of 2026-04-04 (end of session 2)

**Working:**
- ufw firewall has 8188 and 3060 open ✓
- ComfyUI running on `192.168.4.176:8188`, reachable from Mac ✓
- Next.js / FrameForge running on `192.168.4.176:3060`, UI loads in browser ✓
- `.env.local` exists and is loaded by Next ✓
- FrameForge successfully sends prompts to ComfyUI API (tested with "make a video of a shiba inu licking an ice cream cone") ✓
- `ComfyUI-Manager` cloned into `~/ComfyUI/custom_nodes/ComfyUI-Manager` (not yet loaded — needs ComfyUI restart)
- `ComfyUI-VideoHelperSuite` folder exists in `custom_nodes/` (from previous session)
- Stray `/home/lynf/package-lock.json` deleted (Turbopack workspace issue resolved)
- **Key discovery:** ComfyUI runs in a Python venv at `~/ComfyUI/.venv` — must `source` it before pip/python commands. Previous confusion about `pip: command not found` and `No module named pip` was because we were installing into system Python.
- **SSH shortcut:** `ssh frame` works (config alias). No need to type the full IP.

**Blocking issue:**
- ComfyUI returns `Node 'VHS_VideoCombine' not found` when generating.
- Root cause: VHS Python deps (cv2, imageio-ffmpeg) were never installed inside `~/ComfyUI/.venv`. All previous pip attempts this session hit system Python, which has no pip at all.

**Next action (resume here):**
1. `ssh frame`
2. `tmux attach -t frame`
3. New tmux window: `Ctrl+B` then `c`
4. **Activate the venv:**
   ```bash
   source ~/ComfyUI/.venv/bin/activate
   ```
   Prompt should now show `(.venv)`.
5. Install VHS deps inside the venv:
   ```bash
   cd ~/ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite
   pip install -r requirements.txt
   pip install --force-reinstall --no-deps imageio-ffmpeg==0.6.0
   pip install --force-reinstall opencv-python-headless
   python -c "import cv2; print('cv2 version:', cv2.__version__)"
   ```
6. Once `cv2 version: ...` prints, restart ComfyUI (switch to its tmux window, `Ctrl+C`, then `cd ~/ComfyUI && source .venv/bin/activate && python main.py --listen 0.0.0.0 --port 8188 --disable-cuda-malloc`). Watch the startup output for `ComfyUI-VideoHelperSuite` loading with no errors.
7. Reload http://192.168.4.176:8188 — Manager button should now appear in the left sidebar.
8. Reload http://192.168.4.176:3060 and click Generate again — should produce a video.

**Still TODO (after VHS works):**
- Patch `package.json` `"dev"` script to `"next dev -p 3060"` so `PORT=3060` prefix isn't needed every time.
- Verify LTX-Video 2.3 checkpoint and Gemma 3 text encoder are downloaded (`ls ~/ComfyUI/models/checkpoints` and `ls ~/ComfyUI/models/clip`). The setup-comfyui.sh script downloads these — unsure if it completed last run.
- Consider a `npm run start:all` script or systemd units to auto-start ComfyUI + Next on boot.
- First successful end-to-end video generation will be the real "done" signal for this phase.
