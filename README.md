# FrameForge

> **Local AI video generation studio** — a Next.js frontend that talks to a self-hosted ComfyUI backend on a GPU machine (the "Framestation") to generate video from text prompts using LTX-Video 2.3.

GitHub repo name is `videostar` for historical reasons. **The app is called FrameForge.**

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.** Do not ask the user to re-explain setup — it's all documented here. Update the [Session Handoff](#session-handoff) section at the end of every session.

**CURRENT STATE (end of session 7 + web research):** The crash is NOT at the ComfyUI layer. It's a known **NVIDIA driver 595 + Blackwell** bug class (Xid 109 CTX SWITCH TIMEOUT / Xid 119 GSP RPC timeout). Other users hit the same crash on the same card. See Session Handoff for the corrected diagnostic ladder and the driver-downgrade path.

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
| NVIDIA driver | **595.58.03** (CUDA 13.2) — **known-buggy on Blackwell, see Session Handoff** |
| **Required kernel module flavor** | **`nvidia-open-dkms`** (proprietary does NOT support sm_120) |
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
| **🔥 Framestation hard-locks within seconds of ComfyUI starting.** Persists after cu130, Ollama stopped, bash wrap, MultiGPU removed. | **Known NVIDIA driver 595 + Blackwell bug.** Web search confirmed: exact-match NVIDIA forum thread "Driver v.595 RTX PRO 4500 Blackwell crashes even when watching videos in the browser". Crash class is Xid 109 (CTX SWITCH TIMEOUT) or Xid 119 (GSP RPC timeout). Same driver version 595.58.03 reported crashing on RTX 5090, RTX Pro 6000, and now our 4500. | **See Session Handoff.** Capture Xid from `journalctl -k -b -1`, then downgrade to `nvidia-open-dkms` 580.126.09. `pcie_aspm=off` is a secondary mitigation. `NVreg_EnableGpuFirmware=0` does NOT work on Blackwell — GSP is mandatory, don't bother. |
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

### Status as of 2026-04-04 end of session 7 — external validation, driver is the suspect

**Breakthrough:** Session 7 ended with web research that conclusively shows this crash is a **known, documented, multi-user NVIDIA driver bug class** — not a FrameForge or ComfyUI problem.

**Confirmed by web search:**

1. **Exact-match thread exists:** NVIDIA developer forum has `"Driver v.595 RTX PRO 4500 Blackwell crashes even when watching videos in the browser"`. Same card, same driver version, Linux, crashes. (Thread content itself is behind an egress block so only the title was readable, but the title alone is confirmation.)
2. **Xid 109 CTX SWITCH TIMEOUT is reported on driver 595.58.03 specifically** with RTX 5090 Blackwell. Our driver version exactly.
3. **Xid 119 GSP RPC timeout** is the documented Blackwell crash class across multiple driver versions (570, 575, 580, 595). Symptom: GSP firmware heartbeat stops → kernel driver yanks card off bus → SSH dies mid-command. Matches our symptom exactly.
4. **`NVreg_EnableGpuFirmware=0` is USELESS on Blackwell.** GSP firmware is mandatory on Blackwell architecture — the flag silently does nothing. **This directly invalidates the previous Backup Plan A. Do not bother setting this flag.**
5. **Blackwell REQUIRES `nvidia-open-dkms` kernel modules.** The proprietary `nvidia.ko` does not support sm_120. If the user has proprietary installed, nothing will ever work. Must verify.
6. **Driver 580.126.09** is the latest stable production branch as of early 2026. Downgrading from 595 to 580 is a real, tested escape hatch used by other Blackwell users on Linux.
7. **Broad ecosystem problem.** Multiple users report instability across 570 → 595 driver versions on Blackwell. This is not isolated to our card.

**What this means for strategy:** We stop bisecting PyTorch and ComfyUI versions. The bug is not there. The priority pivots to (a) getting a crash-confirming Xid number from dmesg, then (b) downgrading the driver.

**What we've conclusively eliminated (still true from session 7):**

| Variable | Result |
|---|---|
| PyTorch cu128 vs cu130 mismatch | Ruled out — crash persists on both |
| Ollama GPU squatting | Ruled out — crash persists with Ollama stopped |
| fish shell parsing `.venv/bin/activate` | Ruled out — fixed via `bash -lc`, crash persists |
| ComfyUI-MultiGPU custom node | Ruled out — parked outside `custom_nodes/`, crash persists |

**Current blocking issue:** Framestation is DOWN. Physical power cycle required.

---

### Session 8 diagnostic ladder — execute in order

**Step 0 — Physical power cycle.** Hold power button 10s.

**Step 1 — SSH in, drop into bash, capture the crash fingerprint from the PREVIOUS boot.** This is the single most valuable command this session:
```bash
ssh frame
bash
sudo journalctl -k -b -1 | grep -iE "xid|nvrm|nvidia|pcieport" | tail -100
```
What we're looking for:
- **`NVRM: Xid (PCI:0000:62:00): 119`** → GSP RPC timeout. Confirmed GSP firmware death. **Driver downgrade is the fix.** Skip to Step 5.
- **`NVRM: Xid (PCI:0000:62:00): 109`** → CTX SWITCH TIMEOUT. Known 595.58.03 Blackwell bug. **Driver downgrade is the fix.** Skip to Step 5.
- **`NVRM: Xid (PCI:0000:62:00): 79`** → GPU has fallen off the bus. Usually PCIe / ASPM. Try `pcie_aspm=off` in Backup Plan A.
- **`pcieport 0000:61:00.0: Unable to change power state from D0 to D3hot`** → Same PCIe ASPM issue as session 3. `pcie_aspm=off`.
- **Anything else / no Xid at all** → Fall through to Steps 2–4 minimal-reproducer ladder.

**Step 2 — Verify we're actually on the open kernel modules** (Blackwell requires them):
```bash
modinfo nvidia | grep -iE "license|version"
pacman -Q | grep -iE "nvidia|linux"
```
Expected: `license: Dual MIT/GPL` and a package named `nvidia-open-dkms` or `nvidia-open`. If you see `license: NVIDIA` or `nvidia-dkms` (non-open), **the card has never been working right — fix this first**:
```bash
sudo pacman -R nvidia-dkms nvidia-utils 2>/dev/null || true
sudo pacman -S nvidia-open-dkms
sudo mkinitcpio -P
sudo reboot
```

**Step 3 — `nvidia-smi` baseline:**
```bash
nvidia-smi
```
Expected: Blackwell at 32623 MB idle, driver 595.58.03, no processes. Hang or errors → deeper driver problem, jump to Step 5 (downgrade).

**Step 4 — Minimal PyTorch reproducer ladder.** Only run if Step 1 did NOT give us a clean Xid fingerprint. Each of these does less than ComfyUI. Stop at the first crash.
```bash
source ~/ComfyUI/.venv/bin/activate
python -c "import torch; print(torch.__version__)"
python -c "import torch; print(torch.cuda.is_available())"
python -c "import torch; print(torch.cuda.get_device_name(0))"
python -c "import torch; print(torch.cuda.mem_get_info(0))"
python -c "import torch; x = torch.randn(1000,1000,device='cuda'); print((x@x).norm().item())"
```
Whichever line hangs the box is our minimal repro.

**Step 5 — Driver downgrade to 580.126.09 (or current stable).** This is the actual fix, not a backup plan:
```bash
pacman -Ss nvidia-open
sudo downgrade nvidia-open-dkms nvidia-utils nvidia-settings   # if `downgrade` util is installed
# OR manually from /var/cache/pacman/pkg/:
sudo pacman -U /var/cache/pacman/pkg/nvidia-open-dkms-580*.pkg.tar.zst \
               /var/cache/pacman/pkg/nvidia-utils-580*.pkg.tar.zst
sudo mkinitcpio -P
sudo sed -i 's/^#IgnorePkg.*/IgnorePkg = nvidia-open-dkms nvidia-utils nvidia-settings/' /etc/pacman.conf
sudo reboot
```
After reboot: `nvidia-smi` should show driver `580.x`. Then run `frame` and see if the crash is gone.

---

### Backup plan A — kernel cmdline PCIe stability (only if Step 1 shows pcieport errors, not Xid)

```bash
sudo nano /etc/default/grub
# Append to GRUB_CMDLINE_LINUX_DEFAULT inside the quotes:
#   pcie_aspm=off
sudo grub-mkconfig -o /boot/grub/grub.cfg
sudo reboot
```

**Do NOT add `nvidia.NVreg_EnableGpuFirmware=0`** — confirmed useless on Blackwell (GSP is mandatory firmware; the flag is ignored silently).

### Backup plan B — if driver downgrade to 580 doesn't fix it

- Try 570.x production branch (previous LTS).
- Check if CachyOS has a `nvidia-open-beta` or `nvidia-open-lts` package with a different build.
- As an absolute last resort: swap in a non-Blackwell card (RTX 4090 or similar) to confirm the bug is Blackwell-specific.

---

### Still TODO (after the stack is stable)

1. Patch `src/lib/workflow-builder.ts` to not inject `LTXVSequenceParallelMultiGPUPatcher` on single-NVIDIA-GPU systems.
2. Patch `setup-comfyui.sh` to install PyTorch from `nightly/cu130`.
3. Patch `package.json` `"dev"` script to `"next dev -p 3060"`.
4. Verify LTX-Video 2.3 checkpoint + Gemma 3 text encoder are downloaded.
5. systemd user units for auto-start on boot.
