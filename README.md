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

## ✅ GPU STATUS: WORKING — VIDEO GENERATION CONFIRMED (Session 13, April 7 2026)

**The RTX PRO 4500 Blackwell is detected, CUDA-stable, and generating video.**

```
NVIDIA-SMI 595.58.03    Driver Version: 595.58.03    CUDA Version: 13.2
GPU 0: NVIDIA RTX PRO 4500 Blackwell   32623 MiB   Bus 62:00.0
```

### What fixed it — FOUR things

1. **`nvidia-open-dkms` (not proprietary)** — NVIDIA restricts RTX PRO Blackwell (PCI ID `10de:2c31`) to open kernel modules only. Proprietary `nvidia-580xx-dkms` rejects the card with error `(0x22:0x56:897)`.
2. **`thunderbolt` early-loaded in initramfs** — Added to MODULES in `/etc/mkinitcpio.conf` so the Thunderbolt subsystem initializes before `nvidia_drm` tries to probe the card.
3. **GPU clock locking** — Clocks MUST be locked at a fixed speed (min=max) before any CUDA workload. See critical section below.
4. **`NVreg_EnableGpuFirmware=0` in modprobe.d** — Config in `/etc/modprobe.d/nvidia-gsp.conf`. **NOTE:** This is effectively ignored by `nvidia-open-dkms` because the open kernel modules REQUIRE GSP firmware (confirmed via GitHub Discussion #667). Harmless to leave.

---

## 🔴 CRITICAL: GPU CLOCK LOCKING (MANDATORY)

**Blackwell GPUs over USB4/Thunderbolt suffer CUDA hard-locks when the GPU changes power states.** This is a known upstream bug ([NVIDIA/open-gpu-kernel-modules #979](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/979)). When the GPU transitions between power states, the PCIe link renegotiates through the USB4/Thunderbolt tunnel and crashes.

### The rules

1. **Clocks MUST be locked (min = max).** A range like `300,900` will crash because the GPU transitions within the range.
2. **Clocks MUST be set BEFORE any CUDA workload.** Changing clocks while ComfyUI is generating will instantly crash the GPU.
3. **The `frame` script handles this automatically.** Just use `frame` or `frame <speed>`.

### Tested clock speeds (April 7 2026)

| Command | Speed | Status | Est. time for 4s 512p video | Power draw |
|---|---|---|---|---|
| `frame` or `frame 300` | 300 MHz | ✅ STABLE | ~25 min | ~23W |
| `frame 450` | 450 MHz | ✅ STABLE | ~15-20 min | ~26W |
| `frame 700` | 700 MHz | ✅ STABLE | ~8-12 min | ~35-50W |
| `frame 900` | 900 MHz | ❌ CRASH | — | — |
| `-lgc 300,900` (range) | 300-900 | ❌ CRASH | — | — |
| `-lgc 300,1800` (range) | 300-1800 | ❌ CRASH | — | — |

**Current recommended setting: `frame 700`** — best balance of speed and stability.

### What happens without clock locking

The system hard-locks (frozen screen, no SSH, requires power cycle) within seconds of any CUDA compute. Even a simple `torch.randn(4000, 4000, device="cuda")` will crash the system. The crash is caused by the GPU attempting a power state transition, which triggers PCIe link renegotiation through the USB4/Thunderbolt tunnel.

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.**

**Top-15 gotchas:**
1. **The GPU is on Thunderbolt 5 / USB4, not OCuLink and not a motherboard slot.**
2. **🔴 GPU CLOCK LOCKING IS MANDATORY before any CUDA workload. Use `frame <speed>`. See section above.**
3. **🔴 NEVER change GPU clocks while a generation is running. It will crash the system.**
4. **ComfyUI runs inside a Python venv** at `~/ComfyUI/.venv`. Always `source ~/ComfyUI/.venv/bin/activate` BEFORE any pip command.
5. **`next dev` does NOT read `PORT` from `.env.local`.** Always `PORT=3060 npm run dev`.
6. **No stray `package.json` in `/home/lynf/`** — breaks Turbopack.
7. **`ssh frame` only works from the Mac.**
8. **Services die when their terminal closes.** Always use tmux via the `frame` script.
9. **🔥 PyTorch CUDA version MUST match the NVIDIA driver CUDA version.** On open 595.58.03 → cu130.
10. **🔥 Ollama is a GPU squatter.** `sudo systemctl stop ollama` BEFORE starting ComfyUI.
11. **🔥🔥 Default login shell is FISH, not bash.** The ComfyUI venv activate script does NOT work in fish. Always wrap commands in `bash -c '...'` or use the `frame` script.
12. **🔥🔥🔥 Bootloader is systemd-boot, NOT GRUB.** Kernel cmdline in `/boot/loader/entries/linux-cachyos.conf`.
13. **🔥🔥🔥🔥 `lspci` reports Gen 1 x1 for USB4 devices on Linux by design.** Red herring.
14. **🔥🔥🔥🔥🔥 RTX PRO Blackwell REQUIRES `nvidia-open-dkms`.** No proprietary path.
15. **🔥🔥🔥🔥🔥🔥 `NVreg_EnableGpuFirmware=0` is IGNORED by nvidia-open-dkms.** Open modules require GSP. The modprobe.d config is harmless but does nothing on the open driver.

---

## Model Setup

### Required models (all downloaded and verified)

```
📂 ComfyUI/models/
├── 📂 checkpoints/
│   └── ltx-2.3-22b-dev.safetensors          # 46.1 GB — main AV model
├── 📂 text_encoders/
│   ├── 📂 gemma-3-12b-it-fp8/               # Community fp8 conversion
│   │   └── gemma_3_12B_it_fp8_e4m3fn.safetensors   # 13 GB — actual file
│   └── comfy_gemma_3_12B_it.safetensors      # ← symlink to fp8 file above
└── 📂 loras/
    └── 📂 ltxv/ltx2/
        └── ltx-2.3-22b-distilled-lora-384.safetensors  # 7.61 GB — distilled LoRA
```

**IMPORTANT: Symlink gotcha.** The Gemma fp8 file in the community repo is named `gemma_3_12B_it_fp8_e4m3fn.safetensors` (no `comfy_` prefix). The symlink MUST point to the correct filename:

```bash
ln -sf /home/lynf/ComfyUI/models/text_encoders/gemma-3-12b-it-fp8/gemma_3_12B_it_fp8_e4m3fn.safetensors /home/lynf/ComfyUI/models/text_encoders/comfy_gemma_3_12B_it.safetensors
```

### Download commands (if starting fresh)

```bash
cd /home/lynf/ComfyUI
source .venv/bin/activate

# Checkpoint (46 GB)
python -c "from huggingface_hub import hf_hub_download; hf_hub_download('Lightricks/LTX-2.3', 'ltx-2.3-22b-dev.safetensors', local_dir='models/checkpoints')"

# Gemma fp8 text encoder (13 GB) — use community conversion, NOT gated Google repo
python -c "from huggingface_hub import snapshot_download; snapshot_download('GitMylo/LTX-2-comfy_gemma_fp8_e4m3fn', local_dir='models/text_encoders/gemma-3-12b-it-fp8')"

# Create symlink so ComfyUI finds it (note: actual filename has NO comfy_ prefix)
ln -sf /home/lynf/ComfyUI/models/text_encoders/gemma-3-12b-it-fp8/gemma_3_12B_it_fp8_e4m3fn.safetensors /home/lynf/ComfyUI/models/text_encoders/comfy_gemma_3_12B_it.safetensors

# Distilled LoRA (7.6 GB)
python -c "from huggingface_hub import hf_hub_download; hf_hub_download('Lightricks/LTX-2.3', 'ltx-2.3-22b-distilled-lora-384.safetensors', local_dir='models/loras/ltxv/ltx2')"
```

### ComfyUI custom nodes required

| Node package | Provides | Install via |
|---|---|---|
| ComfyUI-LTXVideo (Lightricks) | LTXVConditioning, LTXVScheduler, LTXVPreprocess, etc. | ComfyUI Manager |
| RES4LYF | ClownSampler_Beta, ManualSigmas | ComfyUI Manager |
| ComfyMath | CM_FloatToInt | ComfyUI Manager |
| ComfyUI-VideoHelperSuite | VHS_VideoCombine | ComfyUI Manager |

---

## Shortcuts and configuration

### The `frame` startup script

| Command | What it does |
|---|---|
| `frame` | Starts everything at 300 MHz (safest) |
| `frame 450` | Starts at 450 MHz (1.5x faster) |
| `frame 700` | Starts at 700 MHz (2.3x faster) — **recommended** |

The script (at `/usr/local/bin/frame`) does, in order:
1. Stops Ollama (`sudo systemctl stop ollama`)
2. Enables GPU persistence mode
3. Locks GPU clocks to the specified speed (min=max, no transitions)
4. Sets power limit to 150W
5. Kills any stale tmux sessions
6. Starts ComfyUI in tmux session `comfy` (bash, venv activated)
7. Waits 5 seconds for ComfyUI to initialize
8. Starts Next.js dev server on port 3060 in tmux session `framenext`

**Install/update after git pull:**
```bash
cd /home/lynf/videostar && git pull && sudo install -m 755 scripts/frame /usr/local/bin/frame
```

### Other shortcuts

| Name | Where | What it does |
|---|---|---|
| `ssh frame` | **Mac only** `~/.ssh/config` | Shortcut to `ssh lynf@192.168.4.176` |

### systemd-boot kernel cmdline (`/boot/loader/entries/linux-cachyos.conf`)

```
options root=UUID=e0a02a34-7281-4fbb-b313-adc69090b532 rw rootflags=subvol=/@ zswap.enabled=0 nowatchdog quiet splash nvidia.NVreg_EnableMSI=0 iommu=pt
```

### modprobe.d configs (`/etc/modprobe.d/`)

| File | Content | Purpose |
|---|---|---|
| `nvidia-gsp.conf` | `options nvidia NVreg_EnableGpuFirmware=0`<br>`options nvidia NVreg_EnableGpuFirmwareLogs=0` | Attempted GSP bypass — **ignored by open driver** but harmless |
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
| Python | 3.14.3 |
| PyTorch | 2.12.0.dev20260404+cu130 |
| ComfyUI | 0.18.1 |
| LAN IP | 192.168.4.176/22 |
| SSH user | `lynf` |
| ComfyUI dir | `/home/lynf/ComfyUI` (venv at `.venv`, bash-only) |
| FrameForge dir | `/home/lynf/videostar` |
| Ports | 8188 (ComfyUI), 3060 (Next.js) |
| Max stable clock | 700 MHz (locked, min=max) |

---

## The 12-session root cause chain

The RTX PRO 4500 Blackwell uses a RISC-V GSP (GPU System Processor) that must complete a firmware handshake before the driver can use the GPU. When the GPU sits behind a USB4/Thunderbolt PCIe tunnel (not native PCIe), this handshake has timing issues — likely due to config-space access latency or DMA path differences in the TB5 bridge.

On top of that, NVIDIA's proprietary driver branch flat-out refuses to load for this SKU — it's on an internal allow-list that mandates `nvidia-open-dkms`. Sessions 9–10 wasted time on the proprietary driver because the error code progression (`894 → 897`) was misread as "progress" when it was actually "rejection."

Even after driver detection works, CUDA compute causes hard-locks because Blackwell over USB4 crashes when the GPU changes power states (PCIe link renegotiation through the Thunderbolt tunnel). Clock locking (with min=max to prevent any transitions) prevents this by keeping the GPU in a single, fixed power state. Clock ranges (e.g. 300,900) still crash because the GPU transitions within the range.

---

## Troubleshooting

### System crashes when running ComfyUI or any CUDA workload
**Cause:** GPU clock locking not applied. The GPU transitions power states and crashes the PCIe/USB4 tunnel.
**Fix:** Use `frame` or `frame 700` which locks clocks automatically before starting ComfyUI.

### System crashes after changing GPU clocks
**Cause:** Clocks were changed while a CUDA workload was running, or a clock range was used instead of a fixed value.
**Fix:** NEVER change clocks mid-inference. Always kill ComfyUI first (`tmux kill-session -t comfy`), change clocks, then restart. Always use locked clocks (min=max): `nvidia-smi -lgc 700,700` not `nvidia-smi -lgc 300,700`.

### ComfyUI starts but workflow fails with "value_not_in_list" for checkpoint
**Cause:** Workflow references a model file that doesn't exist on disk.
**Fix:** Verify files exist in `~/ComfyUI/models/checkpoints/`. The current correct checkpoint is `ltx-2.3-22b-dev.safetensors`.

### "Model in folder 'text_encoders' with filename 'comfy_gemma_3_12B_it.safetensors' not found"
**Cause:** The symlink to the Gemma fp8 text encoder is broken. The community fp8 file is named `gemma_3_12B_it_fp8_e4m3fn.safetensors` (no `comfy_` prefix) but the symlink may have been created pointing to the wrong name.
**Fix:** Recreate with correct target: `ln -sf /home/lynf/ComfyUI/models/text_encoders/gemma-3-12b-it-fp8/gemma_3_12B_it_fp8_e4m3fn.safetensors /home/lynf/ComfyUI/models/text_encoders/comfy_gemma_3_12B_it.safetensors`

### "Required input is missing: audio_vae" error
**Cause:** Old workflow missing the LTXVAudioVAELoader node, or referencing wrong checkpoint.
**Fix:** Update to latest `workflow-builder.ts` which includes the full AV pipeline.

### "Required input is missing: perturb_attn, cross_attn, skip_step" on GuiderParameters
**Cause:** Old workflow uses GuiderParameters/MultimodalGuider which changed API in newer ComfyUI-LTXVideo.
**Fix:** Update to latest `workflow-builder.ts` which uses CFGGuider instead.

### fish shell error when activating venv
**Cause:** CachyOS default shell is fish, but Python venv activate script is bash-only.
**Fix:** Always run ComfyUI through bash: `bash -c 'cd ~/ComfyUI && source .venv/bin/activate && python main.py'`

### SSH from Mac hangs at KEXINIT
**Cause:** Suspected Docker bridge iptables interference (many veth/br interfaces on Framestation).
**Status:** Unresolved. Workaround: type commands directly on Framestation or use SSH intermittently.

---

## Workflow architecture (workflow-builder.ts)

The FrameForge app builds ComfyUI API-format JSON workflows. The current pipeline for text-to-video:

```
CheckpointLoaderSimple ──► LoraLoaderModelOnly ──► CFGGuider
                                                       │
LTXAVTextEncoderLoader ──► CLIPTextEncode(+) ──►       │
                       └─► CLIPTextEncode(-) ──► LTXVConditioning ──► CFGGuider
                                                                         │
EmptyLTXVLatentVideo ─────────────┐                                      │
LTXVAudioVAELoader ──► LTXVEmptyLatentAudio ──► LTXVConcatAVLatent      │
                                                       │                  │
                                            LTXVScheduler               │
                                                       │                  │
RandomNoise ──► SamplerCustomAdvanced ◄── KSamplerSelect              │
                       │            ◄── CFGGuider ◄────────────────────┘
                       │            ◄── LTXVScheduler (sigmas)
                       │            ◄── LTXVConcatAVLatent (latent_image)
                       ▼
              LTXVSeparateAVLatent
                  │           │
            VAEDecode    LTXVAudioVAEDecode
                  │           │
              VHS_VideoCombine ──► MP4 output
```

---

## TODO

1. ~~GPU detection~~ **DONE**
2. ~~CUDA compute stability~~ **DONE** (clock locking workaround, 700 MHz max stable)
3. ~~Model downloads~~ **DONE** (checkpoint, Gemma fp8, distilled LoRA)
4. ~~Workflow rewrite~~ **DONE** (workflow-builder.ts updated for LTX-2.3 AV API)
5. ~~Frame script GPU stabilization~~ **DONE** (accepts clock speed arg: `frame 700`)
6. ~~Gemma symlink fix~~ **DONE** (correct filename without comfy_ prefix)
7. **Confirm first video generation completes end-to-end** ← CURRENT
8. **Test 750 MHz and 800 MHz** to narrow the max stable clock
9. **Fix SSH from Mac** — KEXINIT hanging, suspected Docker iptables
10. Mirror kernel cmdline into `linux-cachyos-lts.conf`
11. Remove `nvidia.NVreg_EnableMSI=0` from cmdline (perf improvement)
12. Create systemd user units for auto-start on boot
13. File upstream bug on NVIDIA/open-gpu-kernel-modules linking diagnosis to #974/#979/#1064

---

## Sources
- [Driver 595 + RTX PRO 4500 Blackwell crashes — NVIDIA Developer Forum](https://forums.developer.nvidia.com/t/driver-v-595-rtx-pro-4500-blackwell-crashes-even-when-watching-videos-in-the-browser/365474)
- [RTX 5060 Ti eGPU unable to init — open-gpu-kernel-modules #974](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/974)
- [RTX 5080 TB5 eGPU hard lock — open-gpu-kernel-modules #979](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/979)
- [GSP heartbeat stuck at 0 — open-gpu-kernel-modules #1064](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1064)
- [RTX 5060 Ti GB206 fails GSP over USB4 — tinygrad #14338](https://github.com/tinygrad/tinygrad/issues/14338)
- [USB4 eGPU Gen1 x1 red herring — Framework Community](https://community.frame.work/t/usb4-egpu-limited-to-pcie-gen1-x1-on-framework-13-ryzen-ai-300-bios-03-05/79190/4)
- [NVreg_EnableGpuFirmware=0 ignored by open driver — GitHub Discussion #667](https://github.com/NVIDIA/open-gpu-kernel-modules/discussions/667)
- [LTX-2.3 ComfyUI workflows — Lightricks/ComfyUI-LTXVideo](https://github.com/Lightricks/ComfyUI-LTXVideo/tree/master/example_workflows/2.3)
- [Gemma fp8 text encoder — GitMylo/LTX-2-comfy_gemma_fp8_e4m3fn](https://huggingface.co/GitMylo/LTX-2-comfy_gemma_fp8_e4m3fn)
