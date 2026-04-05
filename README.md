# FrameForge

> **Local AI video generation studio** — a Next.js frontend that talks to a self-hosted ComfyUI backend on a GPU machine (the "Framestation") to generate video from text prompts using LTX-Video 2.3.

GitHub repo name is `videostar` for historical reasons. **The app is called FrameForge.**

---

## What FrameForge is (plain English)

FrameForge is a **local AI video generator**. You type a prompt like "shiba inu licking an ice cream cone," hit generate, and a few minutes later you get an MP4 back. No cloud fees, no sending prompts to anyone's servers, runs entirely on hardware you own.

Two halves talking over your LAN:

- **Frontend (Mac browser):** A Next.js/React web app at `http://192.168.4.176:3060` where you type prompts, pick settings, and download finished videos. This is what lives in the `videostar` repo.
- **Backend (Framestation Linux box):** ComfyUI running LTX-Video 2.3 + Gemma 3 12B text encoder on an NVIDIA RTX PRO 4500 Blackwell (32 GB VRAM). This is the muscle that actually generates the frames.

Flow: Browser → FrameForge UI builds a ComfyUI workflow → POSTs it to ComfyUI → model runs on the Blackwell → video comes back → download. The `frame` command (`/usr/local/bin/frame`, canonical source at `scripts/frame`) is a one-word startup that kills Ollama, starts ComfyUI in tmux, starts Next.js in tmux, and tells you where to point your browser.

Why it matters: runway.ml is $35–95/mo, Sora costs tokens, both keep your prompts. FrameForge is free forever, fully private, as fast as the card can run.

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.** Do not ask the user to re-explain setup — it's all documented here. Update the [Session Handoff](#session-handoff) section at the end of every session.

**CURRENT STATE (end of session 8 part 2):** Root cause localized to **PCIe / NVRM init layer**, BIOS settings are the next move. Kernel cmdline flags `pcie_aspm=off pcie_port_pm=off` are LIVE and confirmed to have eliminated the PCIe hotplug churn (no more `Link Down` / `Card not present` / `D0→D3hot` at boot). But `NVRM: RmInitAdapter failed! (0x22:0x56:894)` still fires — meaning the ASPM power-cycling was a symptom, not the root cause. The real issue is BAR mapping / link training at the BIOS level. Session 9 = BIOS settings (Above 4G Decoding, Resizable BAR, force Gen 4).

**Top-9 gotchas that burn every session:**
1. **ComfyUI runs inside a Python venv** at `~/ComfyUI/.venv`. Always `source ~/ComfyUI/.venv/bin/activate` BEFORE any pip command.
2. **`next dev` does NOT read `PORT` from `.env.local`.** Always `PORT=3060 npm run dev`.
3. **No stray `package.json` in `/home/lynf/`** — breaks Turbopack.
4. **`ssh frame` only works from the Mac.** Alias lives in Mac's `~/.ssh/config`.
5. **Services die when their terminal closes.** Always run them inside tmux — use the `frame` script.
6. **🔥 PyTorch CUDA version MUST match the NVIDIA driver CUDA version.** Currently `nightly/cu130` (driver CUDA 13.2).
7. **🔥 Ollama is a GPU squatter.** `sudo systemctl stop ollama` BEFORE starting ComfyUI. `frame` script handles this.
8. **🔥🔥 Default login shell is FISH, not bash.** `.venv/bin/activate` is bash-syntax. Any command that sources a venv must be wrapped in `bash -lc '...'`. See `scripts/frame`.
9. **🔥🔥🔥 Bootloader is systemd-boot, NOT GRUB.** `/etc/default/grub` is empty. Kernel cmdline lives in `/boot/loader/entries/linux-cachyos.conf` on the `options` line. Backup before editing.

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
| **Bootloader** | **systemd-boot 260.1** |
| **Boot entries** | `/boot/loader/entries/linux-cachyos.conf` (default), `linux-cachyos-lts.conf` |
| **UEFI firmware** | INSYDE Corp. 0.772 (access with `F2` during POST) |
| **Kernel cmdline** (current) | `... rw rootflags=subvol=/@ zswap.enabled=0 nowatchdog quiet splash pcie_aspm=off pcie_port_pm=off` |
| LAN IP | `192.168.4.176` |
| SSH user | `lynf` |
| SSH from Mac | `ssh frame` |
| FrameForge path | `/home/lynf/videostar` |
| ComfyUI path | `/home/lynf/ComfyUI` |
| ComfyUI venv | `/home/lynf/ComfyUI/.venv` (bash-only) |
| tmux sessions | `comfy`, `frame` |
| Startup shortcut | `/usr/local/bin/frame` (canonical: `scripts/frame`) |
| Firewall | `ufw` |
| Ports | 8188 (ComfyUI), 3060 (Next.js) |
| Python in venv | 3.14.3 |
| **Compute GPU** | NVIDIA RTX PRO 4500 Blackwell, 32623 MB, sm_120, PCIe `62:00.0` (parent bridge `61:00.0`, root port `00:01.2`) |
| **Display GPU** | AMD Radeon, PCIe `c3:00.0` |
| NVIDIA driver | **595.58.03** (CUDA 13.2) |
| **NVIDIA kernel module** | **`nvidia-open`** — confirmed loaded as `NVIDIA UNIX Open Kernel Module for x86_64 595.58.03` |
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
   bash
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
   ```
5. **Models:** `huggingface-cli download Lightricks/LTX-Video` to `checkpoints/`, `Kijai/LTX2.3_comfy` to `clip/`
6. **Clean home dir:** `rm -f /home/lynf/package.json /home/lynf/package-lock.json && rm -rf /home/lynf/node_modules`
7. **Install `frame` shortcut:** `cd ~/videostar && git pull && sudo install -m 755 scripts/frame /usr/local/bin/frame`
8. **Kernel cmdline flags:** see Session Handoff.
9. **BIOS:** Above 4G Decoding ON, Resizable BAR ON, PCIe slot link speed Gen 4 (not Auto/Gen 5).

---

## Daily startup

```bash
ssh frame        # from Mac
frame            # on Framestation
```

Watch logs safely (without attaching):
```bash
tmux capture-pane -t comfy -p | tail -80
```

If stuck in tmux: `tmux detach-client -s comfy` from a second SSH session.

---

## Session Handoff

### Status as of 2026-04-04 end of session 8 part 2 — kernel flags live, BIOS is next

**What session 8 proved (in two parts):**

**Part 1 (dmesg capture):** Got the actual crash fingerprint for the first time. Error is `NVRM: RmInitAdapter failed! (0x22:0x56:894)` happening during driver load, with PCIe hotplug reporting `Link Down` / `Card not present` on root port `0000:00:01.2`. This is BEFORE any CUDA runs. Every prior session's "ComfyUI crash" was actually the first ioctl into a half-dead driver that had silently failed to attach at boot.

**Part 2 (flags applied):** Added `pcie_aspm=off pcie_port_pm=off` to `/boot/loader/entries/linux-cachyos.conf` `options` line via sed. Rebooted. Verified with `cat /proc/cmdline` that flags are live. Post-flag dmesg:

```
NVRM: loading NVIDIA UNIX Open Kernel Module for x86_64  595.58.03
NVRM: osInitNvMapping: *** Cannot attach gpu
NVRM: RmInitAdapter: osInitNvMapping failed, bailing out of RmInitAdapter
NVRM: GPU 0000:62:00.0: RmInitAdapter failed! (0x22:0x56:894)
NVRM: GPU 0000:62:00.0: rm_init_adapter failed, device minor number 0
No devices were found
```

**Critical delta from part 1:** The `pciehp: Slot(0-1): Link Down`, `Card not present`, and `pcieport 0000:61:00.0: Unable to change power state from D0 to D3hot` messages are **GONE**. The kernel flags did their job — the hotplug controller is no longer power-cycling the slot under the driver's feet.

**But RmInitAdapter still fails with the same `(0x22:0x56:894)` code.** This means the ASPM/hotplug power churn was a *symptom*, not the root cause. The real bug is that NVRM cannot map the Blackwell's BARs at init time. On modern NVIDIA cards (especially Blackwell), this is almost always one of:

1. **Above 4G Decoding disabled in BIOS** — Blackwell's BAR is >4GB, can't be mapped without this.
2. **Resizable BAR (ReBAR) disabled in BIOS** — Blackwell expects resizable BAR.
3. **PCIe link speed negotiation failing at Gen 5** — force Gen 4 (or Gen 3) in BIOS.
4. **CSM / Legacy boot enabled** — must be off (UEFI-only).

All four are BIOS settings. No more software to try at this layer — we need to get into INSYDE UEFI.

---

### Session 9 entry point — BIOS, in order

**Step 1 — Reboot and enter UEFI.** From SSH: `sudo reboot`. As the machine POSTs, mash `F2` repeatedly (INSYDE firmware). You should land in the INSYDE UEFI setup screen.

**Step 2 — Check/enable these settings** (exact menu paths vary by board, so hunt if needed):

| Setting | Target value | Likely menu |
|---|---|---|
| Above 4G Decoding | **Enabled** | Advanced → PCI Subsystem / PCI Express Configuration |
| Re-Size BAR Support | **Enabled** | Advanced → PCI Subsystem / PCI Express Configuration (requires Above 4G first) |
| CSM Support | **Disabled** | Boot / Advanced |
| Secure Boot | Disabled (already is per `bootctl`) | Security |
| PCIe slot link speed (slot containing Blackwell) | **Gen 4** (not Auto/Gen 5) | Advanced → PCIe slot config |
| IOMMU / AMD-Vi | Leave at Auto for now | Advanced → CPU / Chipset |

**Step 3 — Save and exit.** Box reboots into Linux.

**Step 4 — Verify:**
```bash
ssh frame
bash
cat /proc/cmdline
sudo journalctl -k -b 0 | grep -iE "xid|nvrm|pcieport|pciehp" | tail -80
nvidia-smi
```

**Expected success state:**
- dmesg shows `NVRM: loading NVIDIA UNIX Open Kernel Module...` with NO `RmInitAdapter failed` after it
- `nvidia-smi` lists the Blackwell with 32623 MiB, driver 595.58.03, zero processes, no error
- `No devices were found` is GONE

**Step 5 — If all clean, run the stack:**
```bash
frame
tmux capture-pane -t comfy -p | tail -100
```
Wait for ComfyUI to print `Starting server` without wedging. Then open http://192.168.4.176:3060 from the Mac and generate the shiba inu test video.

---

### Escalation ladder if BIOS doesn't fix it

**Escalation 1: Try Gen 3 instead of Gen 4.** Some boards are marginal even at Gen 4 with new Blackwell silicon.

**Escalation 2: Try another PCIe slot.** If the board has a second x16 slot, move the Blackwell there. Some boards have BIOS bugs where only the primary slot gets full init, others where the secondary is more tolerant.

**Escalation 3: Reseat + power connectors.** Power off, unplug wall, pop the card out, check fingers/slot, push back in until the retention clip clicks. Unplug + replug both ends of the 12VHPWR / PCIe power cable. RTX PRO 4500 Blackwell transient spikes can cause a borderline PSU to brownout during link training.

**Escalation 4: Driver downgrade to 580.126.09.**
```bash
pacman -Ss nvidia-open
sudo downgrade nvidia-open nvidia-utils nvidia-settings
sudo mkinitcpio -P
sudo sed -i 's/^#IgnorePkg.*/IgnorePkg = nvidia-open nvidia-utils nvidia-settings/' /etc/pacman.conf
sudo reboot
```

**Escalation 5: Kernel cmdline exotic flags.**
```bash
sudo sed -i '/^options / s/$/ pci=noaer pci=realloc=on/' /boot/loader/entries/linux-cachyos.conf
```
(`pci=realloc=on` forces the kernel to reallocate BARs, which can work around firmware that mis-sizes them.)

**Escalation 6: Swap in a non-Blackwell GPU** (RTX 4090 or older) to prove the failure is Blackwell-specific vs motherboard-general.

---

### What we've conclusively eliminated across sessions 1–8

| Variable | Result |
|---|---|
| PyTorch cu128 vs cu130 | Ruled out |
| Ollama GPU squatting | Ruled out |
| fish shell parsing `.venv/bin/activate` | Ruled out (fixed via `bash -lc`) |
| ComfyUI-MultiGPU custom node | Ruled out |
| NVIDIA driver 595 CUDA runtime | Ruled out (failure is pre-CUDA) |
| Xid 109/119 GSP firmware | Ruled out (zero Xid entries in dmesg) |
| Proprietary vs open kernel module | Confirmed correct (open is loaded) |
| **PCIe ASPM / hotplug power churn** | **Ruled out (flags applied, symptoms gone, attach still fails)** |

**Remaining unknowns:** BIOS BAR settings, PCIe link speed negotiation, physical seating, PSU headroom.

---

### Still TODO (after the stack is stable)

1. Patch `src/lib/workflow-builder.ts` to not inject `LTXVSequenceParallelMultiGPUPatcher` on single-NVIDIA-GPU systems.
2. Patch `setup-comfyui.sh` to install PyTorch from `nightly/cu130`.
3. Patch `package.json` `"dev"` script to `"next dev -p 3060"`.
4. Verify LTX-Video 2.3 checkpoint + Gemma 3 text encoder are downloaded.
5. systemd user units for auto-start on boot.
6. Mirror kernel cmdline flags into `linux-cachyos-lts.conf` fallback entry.
