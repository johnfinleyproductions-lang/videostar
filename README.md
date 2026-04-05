# FrameForge

> **Local AI video generation studio** — a Next.js frontend that talks to a self-hosted ComfyUI backend on a GPU machine (the "Framestation") to generate video from text prompts using LTX-Video 2.3.

GitHub repo name is `videostar` for historical reasons. **The app is called FrameForge.**

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.** The sections below contain everything you need to know about the environment, paths, ports, known issues, and current status. Do not ask the user to re-explain any of this — it's all documented here. Update the [Session Handoff](#session-handoff) section at the end of every work session so the next session can pick up without going in circles.

**Top-8 gotchas that burn every session:**
1. **ComfyUI runs inside a Python venv** at `~/ComfyUI/.venv`. Always `source ~/ComfyUI/.venv/bin/activate` BEFORE any `pip` or `python -c "import ..."` command. System `/usr/bin/python` has no pip and no cv2 — anything you install there is invisible to ComfyUI.
2. **`next dev` does NOT read `PORT` from `.env.local`.** Always start FrameForge with `PORT=3060 npm run dev`, or patch the `dev` script to `"next dev -p 3060"`.
3. **No stray `package.json` in `/home/lynf/`** — it breaks Turbopack workspace detection and causes `Can't resolve 'tailwindcss'`.
4. **`ssh frame` only works from the Mac.** The alias lives in the Mac's `~/.ssh/config`. If you're already SSH'd into the Framestation, skip it.
5. **Services die when their terminal closes.** Both ComfyUI and `npm run dev` are foreground processes. **Always run them inside tmux.** Use the `frame` shortcut script — it handles this.
6. **🔥 PyTorch CUDA version MUST match the NVIDIA driver CUDA version.** Currently `nightly/cu130` (driver is 595.58.03 / CUDA 13.2). Using cu128 historically caused `Host is down` crashes.
7. **🔥 Ollama is a GPU squatter.** Always `sudo systemctl stop ollama` BEFORE starting ComfyUI. The `frame` script does this automatically.
8. **🔥🔥 Default login shell on this box is FISH, not bash.** `.venv/bin/activate` is bash-syntax and fish cannot source it (errors with `'case' builtin not inside of switch block`). **Any tmux command that sources a venv MUST be wrapped in `bash -lc '...'`** — see `scripts/frame` in this repo for the canonical pattern.

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

- **FrameForge (Next.js)** — this repo. Runs on port **3060**.
- **ComfyUI** — lives on the Framestation at `/home/lynf/ComfyUI`. Runs on port **8188** inside its own Python venv at `~/ComfyUI/.venv`. Uses LTX-Video 2.3 + Gemma 3 text encoder.
- **Both services run on the Framestation.** The Mac is just the browser.

---

## Environment facts (memorize these)

| Thing | Value |
|---|---|
| Machine name | Framestation (hostname `framerbox395`) |
| OS | CachyOS (Arch-based Linux) |
| **User default shell** | **fish** (NOT bash — see gotcha #8) |
| LAN IP | `192.168.4.176` |
| SSH user | `lynf` |
| SSH from Mac | `ssh frame` (Mac-side SSH config alias) |
| FrameForge project path | `/home/lynf/videostar` |
| ComfyUI path | `/home/lynf/ComfyUI` |
| **ComfyUI Python venv** | **`/home/lynf/ComfyUI/.venv`** — bash-only, must be wrapped in `bash -lc` when invoked from fish or tmux |
| ComfyUI custom nodes | `/home/lynf/ComfyUI/custom_nodes` |
| tmux session names | `comfy` (ComfyUI), `frame` (Next.js) |
| **Startup shortcut** | **`/usr/local/bin/frame`** — canonical source in this repo at `scripts/frame`. Wraps both tmux commands in `bash -lc` to bypass fish. Install with `sudo install -m 755 scripts/frame /usr/local/bin/frame`. |
| Firewall | `ufw` |
| Open ports | 8188/tcp, 3060/tcp |
| Python version in venv | 3.14.3 |
| **Compute GPU** | **NVIDIA RTX PRO 4500 Blackwell**, 32623 MB VRAM (sm_120) at PCIe `62:00.0` |
| **Display GPU** | **AMD Radeon** at PCIe `c3:00.0` — drives HDMI/DP, NVIDIA is headless compute |
| NVIDIA driver | **595.58.03** (CUDA 13.2) |
| **PyTorch** | **nightly cu130** — `torch 2.12.0.dev20260404+cu130`, cuda 13.0 confirmed |
| System RAM | 128 GB |
| ComfyUI version | 0.18.1 |
| **Ollama** | Runs on `127.0.0.1:11434` — stop before ComfyUI |

---

## URLs

| Service | URL (from Mac browser) |
|---|---|
| FrameForge (Next.js) | http://192.168.4.176:3060 |
| ComfyUI UI | http://192.168.4.176:8188 |
| ComfyUI WebSocket | ws://192.168.4.176:8188/ws |

---

## First-time setup (if starting from scratch)

**The authoritative setup script is `setup-comfyui.sh` at the repo root.**

> ⚠️ **`setup-comfyui.sh` currently pins PyTorch cu128 — this is WRONG for driver CUDA 13.2.** Patch it to `nightly/cu130` before running, or install PyTorch manually per Step 3.

### 1. Firewall
```bash
sudo ufw allow 8188/tcp && sudo ufw allow 3060/tcp && sudo ufw reload
```

### 2. Clone FrameForge
```bash
cd ~ && git clone https://github.com/johnfinleyproductions-lang/videostar.git
cd videostar && cp .env.example .env.local && npm install
```

### 3. ComfyUI + venv + PyTorch cu130
```bash
cd ~ && git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI && python -m venv .venv
source .venv/bin/activate
nvidia-smi | grep "CUDA Version"   # must be 13.x
pip install --upgrade pip
pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu130
pip install -r requirements.txt
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

### 4. Custom nodes (inside venv)
```bash
source ~/ComfyUI/.venv/bin/activate
cd ~/ComfyUI/custom_nodes
git clone https://github.com/Lightricks/ComfyUI-LTXVideo.git && cd ComfyUI-LTXVideo && pip install -r requirements.txt && cd ..
git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git && cd ComfyUI-VideoHelperSuite && pip install -r requirements.txt && cd ..
git clone https://github.com/ltdrdata/ComfyUI-Manager.git
# ⚠️ MultiGPU under strong suspicion as crash cause — do NOT install until workflow-builder.ts is patched to not require it
# git clone https://github.com/pollockjj/ComfyUI-MultiGPU.git
python -c "import cv2; print('cv2 version:', cv2.__version__)"
```

### 5. Models
```bash
cd ~/ComfyUI/models/checkpoints
huggingface-cli download Lightricks/LTX-Video --include "ltx-av-step-1751000_vocoder_24K.safetensors" --local-dir .
cd ../clip
huggingface-cli download Kijai/LTX2.3_comfy --local-dir .
```

### 6. Clean home dir
```bash
rm -f /home/lynf/package.json /home/lynf/package-lock.json
rm -rf /home/lynf/node_modules
```

### 7. Install the `frame` shortcut
The canonical source is `scripts/frame` in this repo. It wraps both tmux commands in `bash -lc` so it works with fish as the default login shell.
```bash
cd ~/videostar && git pull
sudo install -m 755 scripts/frame /usr/local/bin/frame
```
After that, just type `frame` from any folder.

---

## Daily startup

### The easy way
```bash
ssh frame        # from Mac
frame            # on Framestation
```
Then open http://192.168.4.176:3060. Watch logs without attaching (safer):
```bash
tmux capture-pane -t comfy -p | tail -80
```

### Why `tmux capture-pane` instead of `tmux attach`?
Some terminals intercept `Ctrl+B`, which means once you attach to a tmux session you can't detach without killing your SSH window. `capture-pane -p` prints the last N lines to your current shell without attaching — safer for remote log-watching.

### If you MUST attach and get stuck
From a **second SSH session** (new Mac terminal tab):
```bash
tmux detach-client -s comfy   # or -s frame
```
This forcibly detaches the stuck client. The tmux session keeps running.

---

## Known issues & solutions

| Symptom | Cause | Fix |
|---|---|---|
| **🔥 Framestation hard-locks (`Read from remote host ... Operation timed out`) seconds after ComfyUI starts booting, even with cu130 PyTorch, Ollama stopped, and bash wrap in place.** | **Suspected: ComfyUI-MultiGPU custom node** — highest-correlation variable across 5+ crashes. Also possible: comfy_kitchen CUDA backend on Blackwell, or stale CUDA context from a prior crash. | **1)** Physical power cycle. **2)** `ssh frame`. **3)** `mv ~/ComfyUI/custom_nodes/ComfyUI-MultiGPU ~/ComfyUI/custom_nodes-disabled-MultiGPU` **BEFORE running anything else.** **4)** `frame`. **5)** `tmux capture-pane -t comfy -p \| tail -80`. If clean → MultiGPU confirmed as cause; next step is patching `workflow-builder.ts`. If still crashes → move on to disabling comfy_kitchen CUDA backend. |
| **🔥 Framestation hard-locks + `WARNING: You need pytorch with cu130 or higher` in startup log** | PyTorch cu128 vs driver CUDA 13.2 mismatch | Power cycle, `pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu130`. **Necessary but not sufficient** — see MultiGPU row above. |
| `.venv/bin/activate (line 40): 'case' builtin not inside of switch block` | fish shell trying to parse bash-syntax `.venv/bin/activate` | Wrap the command in `bash -lc '...'`. See `scripts/frame` for the canonical pattern. |
| Stuck in tmux, `Ctrl+B d` does nothing | Terminal app intercepts Ctrl+B, or tmux prefix rebound | From a new SSH tab: `tmux detach-client -s <session-name>` |
| `/usr/bin/python: No module named pip` | System Python, not venv | `source ~/ComfyUI/.venv/bin/activate` |
| `ModuleNotFoundError: No module named 'cv2'` | Installed to wrong Python | Activate venv first |
| Browser `ERR_CONNECTION_REFUSED` | Service not running | Run `frame`, or check `ss -tlnp \| grep <port>` |
| `ssh: Could not resolve hostname frame` | Running `ssh frame` on the Framestation itself | Skip — the alias is Mac-side only |
| Next on port 3001 instead of 3060 | `next dev` ignores `PORT` in `.env.local` | `PORT=3060 npm run dev` |
| ComfyUI `Node 'VHS_VideoCombine' not found` | VHS Python deps missing | Reinstall VHS requirements + `imageio-ffmpeg==0.6.0` + `opencv-python-headless` |
| ComfyUI `Node 'LTXVSequenceParallelMultiGPUPatcher' not found` | FrameForge's `workflow-builder.ts` injects it unconditionally | **Preferred fix: patch `workflow-builder.ts` to skip on single-GPU systems.** Do NOT just install MultiGPU — it's the suspected crash cause. |

---

## Project structure

```
videostar/
├── .env.example
├── next.config.ts
├── package.json              # "dev" script — add -p 3060 for stickiness
├── setup-comfyui.sh          # currently pins cu128, needs cu130 patch
├── scripts/
│   └── frame                 # canonical /usr/local/bin/frame source, bash -lc wrapped
├── docs/
│   └── GPU-TROUBLESHOOTING.md
└── src/
    ├── app/
    ├── components/
    ├── hooks/
    └── lib/
        ├── comfyui-client.ts
        ├── workflow-builder.ts   # injects LTXVSequenceParallelMultiGPUPatcher unconditionally (CRITICAL TODO)
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

---

## Tech stack

**Frontend:** Next.js 16.2.2 (Turbopack), React 19.2, Tailwind CSS 4, Framer Motion 12, Sonner, ws, TypeScript 5

**Backend:**
- ComfyUI 0.18.1
- Python 3.14.3 in `~/ComfyUI/.venv`
- **PyTorch nightly cu130** (`2.12.0.dev20260404+cu130`)
- LTX-Video 2.3, Gemma 3 12B (Kijai)
- ComfyUI-VideoHelperSuite, ComfyUI-LTXVideo, ComfyUI-Manager
- ~~ComfyUI-MultiGPU~~ ⚠️ suspected crash cause — not currently installed

**Hardware:**
- NVIDIA RTX PRO 4500 Blackwell 32 GB at PCIe `0000:62:00.0` (headless compute)
- AMD Radeon at PCIe `0000:c3:00.0` (display)
- 128 GB RAM

---

## Session Handoff

> **Update this section at the end of every session.**

### Status as of 2026-04-04 (end of session 6 — fish/bash fix committed, MultiGPU still the prime suspect)

**Working:**
- `scripts/frame` in-repo, canonical source for `/usr/local/bin/frame`, wraps tmux commands in `bash -lc` ✓
- FrameForge (Next.js) boots cleanly on 3060 under the `frame` tmux session ✓
- PyTorch cu130 confirmed (`2.12.0.dev20260404+cu130`) ✓
- Dual-GPU architecture documented (AMD display + NVIDIA compute) ✓
- fish-vs-bash issue identified and permanently fixed in `scripts/frame` ✓
- Ollama stop automated in `frame` script ✓
- Safer log-watching pattern documented: `tmux capture-pane -t comfy -p | tail -80` (avoids the "stuck in tmux, Ctrl+B doesn't work" trap) ✓

**⚠️ Crashes are still happening — still unresolved.**

**Session 6 attempted crash isolation but failed at step 1: we ran `frame` WITHOUT first moving `ComfyUI-MultiGPU` out of `custom_nodes`.** The box crashed again with the same network-death signature (`Read from remote host ... Operation timed out / client_loop: send disconnect: Broken pipe`).

**What this tells us:**
- cu130 alone → not enough
- cu130 + Ollama stopped → not enough
- cu130 + Ollama stopped + bash wrap → **still not enough**
- MultiGPU is the one variable we have NEVER successfully isolated. Every single crash this project has seen has had MultiGPU present in `custom_nodes/`.

By process of elimination, **MultiGPU is now the highest-confidence suspect** and must be moved aside before next attempt.

**Current blocking issue:**
- Framestation is DOWN as of 2026-04-04 late session 6. Requires physical power cycle.

**Next action (session 7 — execute in exact order, do NOT skip step 3):**

1. **Physical power cycle.** Hold power button 10s.
2. `ssh frame` from Mac.
3. **🔥 CRITICAL — park MultiGPU BEFORE running `frame`:**
   ```bash
   mv ~/ComfyUI/custom_nodes/ComfyUI-MultiGPU ~/ComfyUI/custom_nodes-disabled-MultiGPU
   ls ~/ComfyUI/custom_nodes/   # confirm MultiGPU is gone
   ```
4. Pull the latest `frame` script (has the bash -lc fix):
   ```bash
   cd ~/videostar && git pull
   sudo install -m 755 scripts/frame /usr/local/bin/frame
   ```
5. Launch:
   ```bash
   frame
   ```
6. Watch WITHOUT attaching (avoids the Ctrl+B stuck-in-tmux trap):
   ```bash
   tmux capture-pane -t comfy -p | tail -80
   ```
   Re-run every ~10 seconds for a minute until ComfyUI finishes booting or the box crashes.
7. **Interpret the outcome:**
   - **Reaches `To see the GUI go to: http://0.0.0.0:8188`, box stays alive** → MultiGPU was the cause. Root cause confirmed. Next permanent fix: patch `src/lib/workflow-builder.ts` to not inject `LTXVSequenceParallelMultiGPUPatcher` on single-NVIDIA-GPU systems (query ComfyUI `/system_stats`, count devices, skip when 1). Then the shiba inu test becomes reachable — FrameForge will work for Generate once the app no longer requires that node.
   - **Box crashes again** → MultiGPU is NOT the cause (extremely unlikely at this point but possible). Next suspect: comfy_kitchen CUDA backend on Blackwell FP4/FP8. Try `TORCH_CUDA_ARCH_LIST=12.0 python main.py --disable-cuda-malloc` as the next experiment, or add `pcie_aspm=off` to `/etc/default/grub` GRUB_CMDLINE_LINUX for PCIe bridge stability.

**Still TODO (unchanged, in priority order):**
1. **Patch `src/lib/workflow-builder.ts`** to skip MultiGPU patcher on single-GPU systems. If session 7 confirms MultiGPU is the cause, this is the permanent fix.
2. Patch `setup-comfyui.sh` to install PyTorch from `nightly/cu130` instead of `nightly/cu128`.
3. Patch `package.json` `"dev"` script to `"next dev -p 3060"`.
4. Verify LTX-Video 2.3 checkpoint + Gemma 3 text encoder are downloaded in `~/ComfyUI/models/checkpoints` and `~/ComfyUI/models/clip`.
5. systemd user units for auto-start on boot.
6. `pcie_aspm=off` kernel cmdline as belt-and-suspenders.
7. Consider pinning the NVIDIA driver via CachyOS package pins.
