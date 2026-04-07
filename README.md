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

## ✅ GPU STATUS: WORKING (Session 12+, April 7 2026)

**The RTX PRO 4500 Blackwell is detected and operational.**

```
NVIDIA-SMI 595.58.03    Driver Version: 595.58.03    CUDA Version: 13.2
GPU 0: NVIDIA RTX PRO 4500 Blackwell   32623 MiB   Bus 62:00.0   28°C   7W/200W
```

### What fixed it — THREE things simultaneously

1. **`nvidia-open-dkms` (not proprietary)** — NVIDIA restricts RTX PRO Blackwell (PCI ID `10de:2c31`) to open kernel modules only. Proprietary `nvidia-580xx-dkms` rejects the card with error `(0x22:0x56:897)`.
2. **`thunderbolt` early-loaded in initramfs** — Added to MODULES in `/etc/mkinitcpio.conf` so the Thunderbolt subsystem initializes before `nvidia_drm` tries to probe the card.
3. **`NVreg_EnableGpuFirmware=0` in modprobe.d** — Config in `/etc/modprobe.d/nvidia-gsp.conf`. **NOTE:** This is effectively ignored by `nvidia-open-dkms` because the open kernel modules REQUIRE GSP firmware (confirmed via GitHub Discussion #667). It was part of the original fix attempt and is harmless to leave, but the real fix is items 1 + 2 + the clock locking below.

---

## 🔴 CRITICAL: GPU CLOCK LOCKING (MANDATORY)

**Blackwell GPUs over USB4/Thunderbolt suffer CUDA hard-locks when the GPU changes power states.** This is a known upstream bug ([NVIDIA/open-gpu-kernel-modules #979](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/979)). When the GPU transitions between power states, the PCIe link renegotiates through the USB4/Thunderbolt tunnel and crashes.

**The workaround is to lock GPU clocks so power states never change.** These three commands MUST run before ANY CUDA workload (ComfyUI, PyTorch, anything) after every reboot:

```bash
sudo nvidia-smi -pm 1              # Enable persistence mode (keeps driver loaded)
sudo nvidia-smi -lgc 300,300       # Lock GPU clocks to 300 MHz (prevents state transitions)
sudo nvidia-smi -pl 150            # Set power limit to 150W (minimum for this card)
```

**What happens without clock locking:** The system hard-locks (frozen screen, no SSH, requires power cycle) within seconds of any CUDA compute. Even a simple `torch.randn(4000, 4000, device="cuda")` will crash the system.

**The `frame` startup script does this automatically.** If you start ComfyUI manually, you MUST run these commands first.

### Raising clocks for performance

300 MHz is stable but very slow for inference. Once you confirm stability, you can raise clocks incrementally:

```bash
sudo nvidia-smi -lgc 300,1500    # Test: faster but still locked range
sudo nvidia-smi -lgc 300,2100    # Full speed (may crash — test carefully)
```

If a higher clock range crashes, drop back to the last stable value. The key is that the MIN and MAX must be close enough that the GPU doesn't attempt a power state transition.

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.**

**Top-14 gotchas:**
1. **The GPU is on Thunderbolt 5 / USB4, not OCuLink and not a motherboard slot.**
2. **🔴 GPU CLOCK LOCKING IS MANDATORY before any CUDA workload. See section above.**
3. **ComfyUI runs inside a Python venv** at `~/ComfyUI/.venv`. Always `source ~/ComfyUI/.venv/bin/activate` BEFORE any pip command.
4. **`next dev` does NOT read `PORT` from `.env.local`.** Always `PORT=3060 npm run dev`.
5. **No stray `package.json` in `/home/lynf/`** — breaks Turbopack.
6. **`ssh frame` only works from the Mac.**
7. **Services die when their terminal closes.** Always use tmux via the `frame` script.
8. **🔥 PyTorch CUDA version MUST match the NVIDIA driver CUDA version.** On open 595.58.03 → cu130.
9. **🔥 Ollama is a GPU squatter.** `sudo systemctl stop ollama` BEFORE starting ComfyUI.
10. **🔥🔥 Default login shell is FISH, not bash.** The ComfyUI venv activate script does NOT work in fish. Always wrap commands in `bash -c '...'` or use the `frame` script.
11. **🔥🔥🔥 Bootloader is systemd-boot, NOT GRUB.** Kernel cmdline in `/boot/loader/entries/linux-cachyos.conf`.
12. **🔥🔥🔥🔥 `lspci` reports Gen 1 x1 for USB4 devices on Linux by design.** Red herring.
13. **🔥🔥🔥🔥🔥 RTX PRO Blackwell REQUIRES `nvidia-open-dkms`.** No proprietary path.
14. **🔥🔥🔥🔥🔥🔥 `NVreg_EnableGpuFirmware=0` is IGNORED by nvidia-open-dkms.** Open modules require GSP. The modprobe.d config is harmless but does nothing on the open driver.

---

## Model Setup

### Required models (all downloaded)

```
📂 ComfyUI/models/
├── 📂 checkpoints/
│   └── ltx-2.3-22b-dev.safetensors          # 46.1 GB — main AV model
├── 📂 text_encoders/
│   ├── 📂 gemma-3-12b-it-fp8/               # 27 GB — community fp8 conversion
│   │   └── comfy_gemma_3_12B_it_fp8_e4m3fn.safetensors
│   └── comfy_gemma_3_12B_it.safetensors      # ← symlink to fp8 file above
└── 📂 loras/
    └── 📂 ltxv/ltx2/
        └── ltx-2.3-22b-distilled-lora-384.safetensors  # 7.61 GB — distilled LoRA
```

### Download commands (if starting fresh)

```bash
cd /home/lynf/ComfyUI
source .venv/bin/activate

# Checkpoint (46 GB)
python -c "from huggingface_hub import hf_hub_download; hf_hub_download('Lightricks/LTX-2.3', 'ltx-2.3-22b-dev.safetensors', local_dir='models/checkpoints')"

# Gemma fp8 text encoder (27 GB) — use community conversion, NOT gated Google repo
python -c "from huggingface_hub import snapshot_download; snapshot_download('GitMylo/LTX-2-comfy_gemma_fp8_e4m3fn', local_dir='models/text_encoders/gemma-3-12b-it-fp8')"

# Create symlink so ComfyUI finds it
ln -sf gemma-3-12b-it-fp8/comfy_gemma_3_12B_it_fp8_e4m3fn.safetensors models/text_encoders/comfy_gemma_3_12B_it.safetensors

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

### Shell aliases and commands

| Name | Where | What it does |
|---|---|---|
| `frame` | `/usr/local/bin/frame` | **Stabilizes GPU clocks**, stops Ollama, starts ComfyUI + Next.js in tmux |
| `ssh frame` | **Mac only** `~/.ssh/config` | Shortcut to `ssh lynf@192.168.4.176` |

### What the `frame` script does (in order)

1. Checks `nvidia-smi` is responsive (exits if GPU not detected)
2. Runs GPU stabilization: `nvidia-smi -pm 1`, `-lgc 300,300`, `-pl 150`
3. Stops Ollama (`sudo systemctl stop ollama`)
4. Starts ComfyUI in tmux session `framenext` (bash, venv activated)
5. Waits 5 seconds for ComfyUI to initialize
6. Starts Next.js dev server on port 3060 in same tmux session

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
| LAN IP | 192.168.4.176/22 |
| SSH user | `lynf` |
| ComfyUI | `/home/lynf/ComfyUI` (venv at `.venv`, bash-only) |
| FrameForge | `/home/lynf/videostar` |
| Ports | 8188 (ComfyUI), 3060 (Next.js) |

---

## The 12-session root cause chain

The RTX PRO 4500 Blackwell uses a RISC-V GSP (GPU System Processor) that must complete a firmware handshake before the driver can use the GPU. When the GPU sits behind a USB4/Thunderbolt PCIe tunnel (not native PCIe), this handshake has timing issues — likely due to config-space access latency or DMA path differences in the TB5 bridge.

On top of that, NVIDIA's proprietary driver branch flat-out refuses to load for this SKU — it's on an internal allow-list that mandates `nvidia-open-dkms`. Sessions 9–10 wasted time on the proprietary driver because the error code progression (`894 → 897`) was misread as "progress" when it was actually "rejection."

Even after driver detection works, CUDA compute causes hard-locks because Blackwell over USB4 crashes when the GPU changes power states (PCIe link renegotiation through the Thunderbolt tunnel). Clock locking prevents this by keeping the GPU in a single power state.

---

## Troubleshooting

### System crashes when running ComfyUI or any CUDA workload
**Cause:** GPU clock locking not applied. The GPU transitions power states and crashes the PCIe/USB4 tunnel.
**Fix:** Run the three `nvidia-smi` commands (pm 1, lgc 300,300, pl 150) BEFORE starting ComfyUI. Use the `frame` script which does this automatically.

### ComfyUI starts but workflow fails with "value_not_in_list" for checkpoint
**Cause:** Workflow references a model file that doesn't exist on disk.
**Fix:** Verify files exist in `~/ComfyUI/models/checkpoints/`. The current correct checkpoint is `ltx-2.3-22b-dev.safetensors`.

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
2. ~~CUDA compute stability~~ **DONE** (clock locking workaround)
3. ~~Model downloads~~ **DONE** (checkpoint, Gemma fp8, distilled LoRA)
4. ~~Workflow rewrite~~ **DONE** (workflow-builder.ts updated for LTX-2.3 AV API)
5. ~~Frame script GPU stabilization~~ **DONE** (auto-runs nvidia-smi before ComfyUI)
6. **Test end-to-end video generation** ← CURRENT
7. **Raise GPU clocks for performance** — test 300-1500, then 300-2100
8. **Fix SSH from Mac** — KEXINIT hanging, suspected Docker iptables
9. Mirror kernel cmdline into `linux-cachyos-lts.conf`
10. Remove `nvidia.NVreg_EnableMSI=0` from cmdline (perf improvement)
11. Create systemd user units for auto-start on boot
12. File upstream bug on NVIDIA/open-gpu-kernel-modules linking diagnosis to #974/#979/#1064

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
