# FrameForge

> **Local AI video generation studio** — a Next.js frontend that talks to a self-hosted ComfyUI backend on a GPU machine (the "Framestation") to generate video from text prompts using LTX-Video 2.3.

GitHub repo name is `videostar` for historical reasons. **The app is called FrameForge.**

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.** Do not ask the user to re-explain setup — it's all documented here. Update the [Session Handoff](#session-handoff) section at the end of every session.

**CURRENT STATE OF THE INVESTIGATION: The crash is NOT at the ComfyUI layer.** Sessions 1–7 eliminated every ComfyUI-level variable (PyTorch cu128→cu130, Ollama, fish shell, MultiGPU). Crashes still reproduce. The issue is in the PyTorch/driver/PCIe stack below ComfyUI. See Session Handoff for the exact diagnostic ladder.

**Top-8 gotchas that burn every session:**
1. **ComfyUI runs inside a Python venv** at `~/ComfyUI/.venv`. Always `source ~/ComfyUI/.venv/bin/activate` BEFORE any pip command.
2. **`next dev` does NOT read `PORT` from `.env.local`.** Always `PORT=3060 npm run dev`.
3. **No stray `package.json` in `/home/lynf/`** — breaks Turbopack.
4. **`ssh frame` only works from the Mac.** Alias lives in Mac's `~/.ssh/config`.
5. **Services die when their terminal closes.** Always run them inside tmux — use the `frame` script.
6. **🔥 PyTorch CUDA version MUST match the NVIDIA driver CUDA version.** Currently `nightly/cu130` (driver CUDA 13.2).
7. **🔥 Ollama is a GPU squatter.** `sudo systemctl stop ollama` BEFORE starting ComfyUI. `frame` script handles this.
8. **🔥🔥 Default login shell is FISH, not bash.** `.venv/bin/activate` is bash-syntax. **Any command that sources a venv must be wrapped in `bash -lc '...'`.** See `scripts/frame`.

---

## Architecture

```
┌──────────────────┐     HTTP/WebSocket    ┌──────────────────────┐
│  Mac (browser)   │ ────────────────────► │  Framestation (GPU)  │
└──────────────────┘     LAN 192.168.4.x   │  CachyOS / Linux     │
                                            │  Next.js :3060       │
                                            │  ComfyUI :8188       │
                                            └──────────────────────┘
```

---

## Environment facts

| Thing | Value |
|---|---|
| Hostname | `framerbox395` (Framestation) |
| OS | CachyOS (Arch-based) |
| **User default shell** | **fish** (NOT bash) |
| LAN IP | `192.168.4.176` |
| SSH user | `lynf` |
| SSH from Mac | `ssh frame` |
| FrameForge path | `/home/lynf/videostar` |
| ComfyUI path | `/home/lynf/ComfyUI` |
| ComfyUI venv | `/home/lynf/ComfyUI/.venv` (bash-only) |
| tmux sessions | `comfy`, `frame` |
| Startup shortcut | `/usr/local/bin/frame` (canonical: `scripts/frame` in this repo) |
| Firewall | `ufw` |
| Ports | 8188 (ComfyUI), 3060 (Next.js) |
| Python in venv | 3.14.3 |
| **Compute GPU** | NVIDIA RTX PRO 4500 Blackwell, 32623 MB, sm_120, PCIe `62:00.0` |
| **Display GPU** | AMD Radeon, PCIe `c3:00.0` |
| NVIDIA driver | **595.58.03** (CUDA 13.2) |
| PyTorch | **nightly cu130** — `2.12.0.dev20260404+cu130` |
| RAM | 128 GB |
| ComfyUI | 0.18.1 |
| Ollama | `127.0.0.1:11434` — stop before ComfyUI |

---

## URLs

| Service | URL |
|---|---|
| FrameForge | http://192.168.4.176:3060 |
| ComfyUI | http://192.168.4.176:8188 |

---

## First-time setup

> ⚠️ **`setup-comfyui.sh` currently pins cu128 — patch to `nightly/cu130` before running.**

1. **Firewall:** `sudo ufw allow 8188/tcp && sudo ufw allow 3060/tcp && sudo ufw reload`
2. **Clone FrameForge:** `cd ~ && git clone https://github.com/johnfinleyproductions-lang/videostar.git && cd videostar && cp .env.example .env.local && npm install`
3. **ComfyUI + venv + PyTorch cu130:**
   ```bash
   cd ~ && git clone https://github.com/comfyanonymous/ComfyUI.git
   cd ComfyUI && python -m venv .venv
   bash   # drop into bash because default shell is fish
   source .venv/bin/activate
   pip install --upgrade pip
   pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu130
   pip install -r requirements.txt
   ```
4. **Custom nodes (inside venv, under bash):**
   ```bash
   cd ~/ComfyUI/custom_nodes
   git clone https://github.com/Lightricks/ComfyUI-LTXVideo.git && cd ComfyUI-LTXVideo && pip install -r requirements.txt && cd ..
   git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git && cd ComfyUI-VideoHelperSuite && pip install -r requirements.txt && cd ..
   git clone https://github.com/ltdrdata/ComfyUI-Manager.git
   # Do NOT install ComfyUI-MultiGPU — it was ruled out as the crash cause, but workflow-builder.ts still injects its node. Either install it AND patch workflow-builder.ts, or just patch workflow-builder.ts (preferred).
   ```
5. **Models:** `huggingface-cli download Lightricks/LTX-Video` to `checkpoints/`, `Kijai/LTX2.3_comfy` to `clip/`
6. **Clean home dir:** `rm -f /home/lynf/package.json /home/lynf/package-lock.json && rm -rf /home/lynf/node_modules`
7. **Install `frame` shortcut:** `cd ~/videostar && git pull && sudo install -m 755 scripts/frame /usr/local/bin/frame`

---

## Daily startup

```bash
ssh frame        # from Mac
frame            # on Framestation
```

Watch logs safely (without attaching — avoids the Ctrl+B stuck-in-tmux trap):
```bash
tmux capture-pane -t comfy -p | tail -80
```

If you get stuck in tmux, from a fresh SSH session: `tmux detach-client -s comfy`

---

## Known issues & solutions

| Symptom | Cause | Fix |
|---|---|---|
| **🔥 Framestation hard-locks (`Read from remote host ... Operation timed out`) within seconds of ComfyUI starting.** Persists even after: cu130 PyTorch, Ollama stopped, bash wrap, **MultiGPU removed**. | **Unknown — below ComfyUI layer.** Remaining suspects: (a) PyTorch nightly cu130 + driver 595.58.03 interaction on Blackwell; (b) comfy_kitchen CUDA backend hitting Blackwell FP4/FP8 code path; (c) PCIe ASPM on bridge `0000:61:00.0` (early dmesg showed `Unable to change power state from D0 to D3hot`); (d) NVIDIA GSP firmware instability on Blackwell with this driver version. | **See Session Handoff diagnostic ladder** — minimal isolated CUDA tests outside ComfyUI, then `pcie_aspm=off nvidia.NVreg_EnableGpuFirmware=0` kernel cmdline, then driver downgrade as last resort. |
| `.venv/bin/activate (line 40): 'case' builtin not inside of switch block` | fish trying to parse bash-syntax activate script | Wrap in `bash -lc '...'` or drop into `bash` first |
| Stuck in tmux, `Ctrl+B d` does nothing | Terminal intercepts Ctrl+B | From a second SSH session: `tmux detach-client -s <name>` |
| `/usr/bin/python: No module named pip` | System Python, not venv | `source ~/ComfyUI/.venv/bin/activate` (under bash) |
| Browser `ERR_CONNECTION_REFUSED` | Service not running | `frame` |
| Next on 3001 instead of 3060 | `next dev` ignores `PORT` in `.env.local` | `PORT=3060 npm run dev` |
| ComfyUI `Node 'LTXVSequenceParallelMultiGPUPatcher' not found` | FrameForge's `workflow-builder.ts` injects it unconditionally | **Preferred fix: patch `workflow-builder.ts` to skip on single-GPU systems.** |

---

## Project structure

```
videostar/
├── .env.example
├── next.config.ts
├── package.json
├── setup-comfyui.sh          # needs cu130 patch
├── scripts/
│   └── frame                 # canonical /usr/local/bin/frame source
└── src/
    └── lib/
        └── workflow-builder.ts   # injects LTXVSequenceParallelMultiGPUPatcher (TODO)
```

---

## Tech stack

**Frontend:** Next.js 16.2.2, React 19.2, Tailwind 4, TypeScript 5
**Backend:** ComfyUI 0.18.1, Python 3.14.3, **PyTorch nightly cu130**, LTX-Video 2.3, Gemma 3 12B
**Hardware:** NVIDIA RTX PRO 4500 Blackwell (32 GB, headless), AMD Radeon (display), 128 GB RAM

---

## Session Handoff

### Status as of 2026-04-04 end of session 7 — MultiGPU RULED OUT, crash is below ComfyUI

**What we've conclusively eliminated (variables confirmed to NOT be the crash cause):**

| Variable | How it was tested | Result |
|---|---|---|
| PyTorch cu128 vs cu130 mismatch | Upgraded to nightly cu130 | Warning gone, crash remained |
| Ollama GPU squatting | `sudo systemctl stop ollama` via `frame` script | Crash remained |
| fish shell parsing `.venv/bin/activate` | Wrapped tmux commands in `bash -lc` | Crash remained |
| **ComfyUI-MultiGPU custom node** | **Moved out of `custom_nodes/` in session 7, ran `frame`** | **Crash remained — RULED OUT** |

**Conclusion:** The crash is NOT in the ComfyUI application layer. It's in the **PyTorch runtime / NVIDIA driver / PCIe / hardware firmware stack** below ComfyUI. We have been treating this as a ComfyUI config problem for 7 sessions. It isn't one.

**Remaining suspects (ordered by likelihood and testability):**

1. **PyTorch nightly cu130 + driver 595.58.03 interaction** — specifically the `torch.cuda.mem_get_info()` call that `comfy/model_management.py` makes during startup. This was the specific Python traceback we saw in session 5 before the lockup. Might reproduce in bare Python with zero ComfyUI involvement.
2. **PCIe ASPM** on bridge `0000:61:00.0`. Very first dmesg error back in session 3 was `pcieport 0000:61:00.0: Unable to change power state from D0 to D3hot, device inaccessible`. We assumed fixing PyTorch made that moot. Maybe the bridge is still trying to D3-sleep the Blackwell card and taking down the bus. Fix: `pcie_aspm=off` at kernel cmdline.
3. **NVIDIA GSP firmware** — the 5xx driver series offloads a lot of runtime work to a firmware blob running on the GPU itself. Blackwell + brand-new driver + cu130 nightly is a combination that has known stability issues. Fix: `nvidia.NVreg_EnableGpuFirmware=0` at kernel cmdline to fall back to host-side runtime.
4. **Driver version 595.58.03** — very new. If cmdline flags don't help, downgrade to a CachyOS-known-good driver (e.g. 565.x production branch).
5. **comfy_kitchen CUDA backend** on Blackwell — got enabled when we moved to cu130 (was disabled on cu128). Could be hitting a code path the driver can't handle. Would need to disable via env var or ComfyUI flag, BUT we should prove this suspicion by reproducing the crash without ComfyUI involved first.

**Current blocking issue:**
- Framestation is DOWN as of 2026-04-04 late session 7. Requires physical power cycle.

---

### Session 8 diagnostic ladder — execute in order, STOP at the first crash

The strategy is to **reproduce the crash with progressively less code** until we find the minimal reproducer. Every step below does less than the previous step. Whichever step crashes the box, we've found the layer where the bug lives.

**Step 0 — Physical power cycle.** Hold power button 10s.

**Step 1 — SSH in and drop into bash:**
```bash
ssh frame
bash
source ~/ComfyUI/.venv/bin/activate
```

**Step 2 — `nvidia-smi` baseline.** Confirms GPU is healthy after power cycle:
```bash
nvidia-smi
```
Expected: Blackwell at 32623 MB idle, driver 595.58.03, no processes. If this hangs or reports errors, we have a deeper problem — `sudo dkms autoinstall && sudo reboot`.

**Step 3 — `import torch` only.** Does importing PyTorch alone crash the box?
```bash
python -c "print('about to import'); import torch; print('torch imported, version:', torch.__version__)"
```
- If **CRASHES** → PyTorch nightly import itself is poison. Jump to "Backup plan A: kernel cmdline flags" below.
- If **SUCCEEDS** → continue.

**Step 4 — `torch.cuda.is_available()`.** Does CUDA init alone crash?
```bash
python -c "import torch; print('cuda available:', torch.cuda.is_available())"
```
- If **CRASHES** → CUDA runtime init on Blackwell is the bug. Jump to Backup plan A.
- If **SUCCEEDS** with `True` → continue.

**Step 5 — `torch.cuda.get_device_name(0)`.** Does device enumeration crash?
```bash
python -c "import torch; torch.cuda.is_available(); print('device:', torch.cuda.get_device_name(0))"
```
- If **CRASHES** → device enumeration is the bug. Jump to Backup plan A.
- If **SUCCEEDS** → continue.

**Step 6 — THE CRITICAL CALL: `torch.cuda.mem_get_info(0)`.** This is exactly what `comfy/model_management.py` does during startup, and is where we saw the `cudaErrorDevicesUnavailable` traceback in session 5.
```bash
python -c "import torch; _ = torch.cuda.is_available(); free, total = torch.cuda.mem_get_info(0); print(f'free: {free}, total: {total}')"
```
- If **CRASHES** → this is our minimal reproducer. We've isolated the bug to a single PyTorch function call on Blackwell + driver 595.58.03. File a PyTorch bug, or jump to Backup plan A to work around at the kernel level.
- If **SUCCEEDS** → go to step 7.

**Step 7 — allocate a tensor on the GPU:**
```bash
python -c "import torch; x = torch.randn(1000, 1000, device='cuda'); y = x @ x; print('matmul ok, result norm:', y.norm().item())"
```
- If **CRASHES** → kernel launch / memory allocation is the bug.
- If **SUCCEEDS** → CUDA is actually working fine in isolation, and the bug is something ComfyUI specifically does. Go to step 8.

**Step 8 — start ComfyUI bare (no custom nodes at all):**
```bash
mv ~/ComfyUI/custom_nodes ~/ComfyUI/custom_nodes-parked
mkdir ~/ComfyUI/custom_nodes
cd ~/ComfyUI
python main.py --listen 0.0.0.0 --port 8188 --disable-cuda-malloc
```
- If **CRASHES** → ComfyUI core itself triggers something custom nodes didn't. Possibly `comfy_kitchen` backend init. Try adding `COMFYUI_DISABLE_KITCHEN=1` env var or similar.
- If **SUCCEEDS** → start putting custom nodes back one at a time (LTX-Video first, then VHS, then Manager) to find which one trips the crash.

---

### Backup plan A — kernel cmdline stability flags

If any step 3–6 crashes, the issue is below Python, and we need hardware-level mitigations. Add the following to GRUB:

```bash
sudo nano /etc/default/grub
```
Find the `GRUB_CMDLINE_LINUX_DEFAULT="..."` line and append (inside the quotes):
```
pcie_aspm=off nvidia.NVreg_EnableGpuFirmware=0
```

Then regenerate grub config and reboot:
```bash
sudo grub-mkconfig -o /boot/grub/grub.cfg
sudo reboot
```

- **`pcie_aspm=off`** — disables PCIe Active State Power Management. Prevents the bridge `0000:61:00.0` from ever trying to put the Blackwell card into D3 sleep state, which is what was hanging the bus early in this investigation.
- **`nvidia.NVreg_EnableGpuFirmware=0`** — disables NVIDIA's GSP firmware offload. On Blackwell + recent drivers, GSP has been a common source of instability. This falls back to the legacy host-side CUDA runtime.

After reboot, re-run Step 1 and the ladder from Step 2.

### Backup plan B — driver downgrade

If Backup plan A doesn't help, the driver itself (`595.58.03`) is the problem. Pin CachyOS to the latest 565.x production branch (or whatever is current at the time):
```bash
sudo pacman -Syu nvidia-dkms=565.57.01-1   # example — use actual available version
sudo mkinitcpio -P
sudo reboot
```

If the driver downgrade fixes it, pin the package in `/etc/pacman.conf` under `[options]` with `IgnorePkg = nvidia-dkms nvidia-utils`.

---

### Still TODO (after the stack is stable)

1. Patch `src/lib/workflow-builder.ts` to not inject `LTXVSequenceParallelMultiGPUPatcher` on single-NVIDIA-GPU systems (query `/system_stats`, skip when count == 1). This is the permanent FrameForge fix even though MultiGPU is no longer suspected — it's still an unnecessary dependency.
2. Patch `setup-comfyui.sh` to install PyTorch from `nightly/cu130`.
3. Patch `package.json` `"dev"` script to `"next dev -p 3060"`.
4. Verify LTX-Video 2.3 checkpoint + Gemma 3 text encoder are downloaded.
5. systemd user units for auto-start on boot.
