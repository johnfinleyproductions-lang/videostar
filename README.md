# FrameForge

> **Local AI video generation studio** — a Next.js frontend that talks to a self-hosted ComfyUI backend on a GPU machine (the "Framestation") to generate video from text prompts using LTX-Video 2.3.

GitHub repo name is `videostar` for historical reasons. **The app is called FrameForge.**

---

## What FrameForge is (plain English)

FrameForge is a **local AI video generator**. You type a prompt like "shiba inu licking an ice cream cone," hit generate, and a few minutes later you get an MP4 back. No cloud fees, no sending prompts to anyone's servers, runs entirely on hardware you own.

Two halves talking over your LAN:

- **Frontend (Mac browser):** A Next.js/React web app at `http://192.168.4.176:3060` where you type prompts, pick settings, and download finished videos. This is what lives in the `videostar` repo.
- **Backend (Framestation Linux box):** ComfyUI running LTX-Video 2.3 + Gemma 3 12B text encoder on an NVIDIA RTX PRO 4500 Blackwell sitting inside a **Thunderbolt 5 / USB4 eGPU dock**, connected to a Framework Desktop (Ryzen AI Max / Strix Halo) over a USB4 cable.

Flow: Browser → FrameForge UI builds a ComfyUI workflow → POSTs it to ComfyUI → model runs on the Blackwell → video comes back → download.

---

## ✅ GPU STATUS: WORKING (Session 12, April 6 2026)

**The RTX PRO 4500 Blackwell is detected and operational.**

```
NVIDIA-SMI 595.58.03    Driver Version: 595.58.03    CUDA Version: 13.2
GPU 0: NVIDIA RTX PRO 4500 Blackwell   32623 MiB   Bus 62:00.0   28°C   7W/200W
```

### What fixed it

The GPU required THREE things simultaneously:

1. **`nvidia-open-dkms` (not proprietary)** — NVIDIA restricts RTX PRO Blackwell (PCI ID `10de:2c31`) to open kernel modules only. Proprietary `nvidia-580xx-dkms` rejects the card with error `(0x22:0x56:897)`.
2. **`NVreg_EnableGpuFirmware=0`** — Disables the Blackwell GSP (GPU System Processor) boot path, which fails over USB4/Thunderbolt PCIe tunneling. Config in `/etc/modprobe.d/nvidia-gsp.conf`.
3. **`thunderbolt` early-loaded in initramfs** — Added to MODULES in `/etc/mkinitcpio.conf` so the Thunderbolt subsystem initializes before `nvidia_drm` tries to probe the card.

### The 12-session root cause chain

The RTX PRO 4500 Blackwell uses a RISC-V GSP (GPU System Processor) that must complete a firmware handshake before the driver can use the GPU. When the GPU sits behind a USB4/Thunderbolt PCIe tunnel (not native PCIe), this handshake fails — likely due to timing, config-space access latency, or DMA path differences in the TB5 bridge. `NVreg_EnableGpuFirmware=0` forces the driver to use the legacy host-side Resource Manager code path, bypassing GSP entirely.

On top of that, NVIDIA's proprietary driver branch flat-out refuses to load for this SKU — it's on an internal allow-list that mandates `nvidia-open-dkms`. Sessions 9–10 wasted time on the proprietary driver because the error code progression (`894 → 897`) was misread as "progress" when it was actually "rejection."

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.**

**Top-12 gotchas:**
1. **The GPU is on Thunderbolt 5 / USB4, not OCuLink and not a motherboard slot.**
2. **ComfyUI runs inside a Python venv** at `~/ComfyUI/.venv`. Always `source ~/ComfyUI/.venv/bin/activate` BEFORE any pip command.
3. **`next dev` does NOT read `PORT` from `.env.local`.** Always `PORT=3060 npm run dev`.
4. **No stray `package.json` in `/home/lynf/`** — breaks Turbopack.
5. **`ssh frame` only works from the Mac.**
6. **Services die when their terminal closes.** Always use tmux via the `frame` script.
7. **🔥 PyTorch CUDA version MUST match the NVIDIA driver CUDA version.** On open 595.58.03 → cu130.
8. **🔥 Ollama is a GPU squatter.** `sudo systemctl stop ollama` BEFORE starting ComfyUI.
9. **🔥🔥 Default login shell is FISH, not bash.**
10. **🔥🔥🔥 Bootloader is systemd-boot, NOT GRUB.** Kernel cmdline in `/boot/loader/entries/linux-cachyos.conf`.
11. **🔥🔥🔥🔥 `lspci` reports Gen 1 x1 for USB4 devices on Linux by design.** Red herring.
12. **🔥🔥🔥🔥🔥 RTX PRO Blackwell REQUIRES `nvidia-open-dkms`.** No proprietary path.

---

## Shortcuts and configuration

### Shell aliases and commands

| Name | Where | What it does |
|---|---|---|
| `frame` | `/usr/local/bin/frame` | Stops Ollama, starts ComfyUI + Next.js in tmux |
| `ssh frame` | **Mac only** `~/.ssh/config` | Shortcut to `ssh lynf@192.168.4.176` |

### systemd-boot kernel cmdline (`/boot/loader/entries/linux-cachyos.conf`)

```
options root=UUID=e0a02a34-7281-4fbb-b313-adc69090b532 rw rootflags=subvol=/@ zswap.enabled=0 nowatchdog quiet splash nvidia.NVreg_EnableMSI=0 iommu=pt
```

### modprobe.d configs (`/etc/modprobe.d/`)

| File | Content | Purpose |
|---|---|---|
| `nvidia-gsp.conf` | `options nvidia NVreg_EnableGpuFirmware=0`<br>`options nvidia NVreg_EnableGpuFirmwareLogs=0` | **THE FIX** — bypasses GSP over USB4/TB5 |
| `nvidia-blackwell.conf` | `options nvidia NVreg_OpenRmEnableUnsupportedGpus=1` | Force-enable experimental GPU IDs |

### mkinitcpio MODULES

`thunderbolt` added to MODULES array — ensures TB subsystem loads before nvidia_drm.

### NVIDIA driver packages (session 12)

| Package | Version |
|---|---|
| `nvidia-open-dkms` | `595.58.03-1` |
| `nvidia-utils` | `595.58.03-1` |
| `opencl-nvidia` | `595.58.03-1` |
| `cuda` | `13.2.0-1` |

---

## Hardware

```
┌──────────────────────────┐        ┌────────────────────────────┐
│  Framework Desktop       │        │  TBGAA Thunderbolt/USB4    │
│  AMD Ryzen AI Max+ 395   │        │  eGPU dock                 │
│  (Strix Halo, 32 cores)  │  USB4  │  (Micro Computer HK)       │
│  Intel JHL9480 Barlow    │◄══════►│  gen: USB4 40 Gb/s ×2      │
│  Ridge TB5 host bridge   │ cable  │  PCIe x16 slot             │
│  InsydeH2O BIOS 0.772    │        │  └── RTX PRO 4500 Blackwell│
│  CachyOS, systemd-boot   │        │      32 GB VRAM, sm_120    │
│  boltd authorizes device │        │      PCI 0000:62:00.0      │
│  128 GB RAM              │        │      PCI ID 10de:2c31      │
└──────────────────────────┘        └────────────────────────────┘
       │
       │ LAN 192.168.4.176
       ▼
┌──────────────────┐
│  Mac (browser)   │
│  FrameForge :3060│
└──────────────────┘
```

---

## Environment facts

| Thing | Value |
|---|---|
| Hostname | `framerbox395` |
| Host machine | Framework Desktop (AMD Ryzen AI Max+ 395, Strix Halo) |
| eGPU | TBGAA USB4 dock (Micro Computer HK) |
| Compute GPU | **✅ NVIDIA RTX PRO 4500 Blackwell, 32623 MiB, WORKING** |
| OS | CachyOS x86_64 (Arch-based) |
| Kernel | Linux 6.19.11-1-cachyos |
| NVIDIA driver | nvidia-open-dkms 595.58.03 |
| CUDA | 13.2 |
| LAN IP | 192.168.4.176/22 |
| SSH user | `lynf` |
| ComfyUI | `/home/lynf/ComfyUI` (venv at `.venv`, bash-only) |
| FrameForge | `/home/lynf/videostar` |
| Ports | 8188 (ComfyUI), 3060 (Next.js) |

---

## Session 12 Handoff — TODO

1. ~~GPU detection~~ **DONE**
2. **Verify PyTorch CUDA matches driver** — need cu130 for CUDA 13.2
3. **Test ComfyUI + LTX-Video 2.3 end-to-end** — generate a test video
4. **Fix SSH from Mac** — key exchange hanging at KEXINIT
5. Mirror kernel cmdline into `linux-cachyos-lts.conf`
6. Patch `src/lib/workflow-builder.ts` — skip MultiGPU patcher on single-GPU
7. Patch `setup-comfyui.sh` — PyTorch cu130
8. Patch `package.json` `"dev"` → `"next dev -p 3060"`
9. Verify LTX-Video 2.3 + Gemma 3 models downloaded
10. systemd user units for auto-start
11. Remove `nvidia.NVreg_EnableMSI=0` from cmdline (perf)
12. File upstream bug on NVIDIA/open-gpu-kernel-modules

---

## Sources
- [Driver 595 + RTX PRO 4500 Blackwell crashes — NVIDIA Developer Forum](https://forums.developer.nvidia.com/t/driver-v-595-rtx-pro-4500-blackwell-crashes-even-when-watching-videos-in-the-browser/365474)
- [RTX 5060 Ti eGPU unable to init — open-gpu-kernel-modules #974](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/974)
- [RTX 5080 TB5 eGPU hard lock — open-gpu-kernel-modules #979](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/979)
- [GSP heartbeat stuck at 0 — open-gpu-kernel-modules #1064](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1064)
- [RTX 5060 Ti GB206 fails GSP over USB4 — tinygrad #14338](https://github.com/tinygrad/tinygrad/issues/14338)
- [USB4 eGPU Gen1 x1 red herring — Framework Community](https://community.frame.work/t/usb4-egpu-limited-to-pcie-gen1-x1-on-framework-13-ryzen-ai-300-bios-03-05/79190/4)
