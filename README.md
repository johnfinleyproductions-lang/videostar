# FrameForge

> **Local AI video generation studio** — a Next.js frontend that talks to a self-hosted ComfyUI backend on a GPU machine (the "Framestation") to generate video from text prompts using LTX-Video 2.3.

GitHub repo name is `videostar` for historical reasons. **The app is called FrameForge.**

---

## What FrameForge is (plain English)

FrameForge is a **local AI video generator**. You type a prompt like "shiba inu licking an ice cream cone," hit generate, and a few minutes later you get an MP4 back. No cloud fees, no sending prompts to anyone's servers, runs entirely on hardware you own.

Two halves talking over your LAN:

- **Frontend (Mac browser):** A Next.js/React web app at `http://192.168.4.176:3060` where you type prompts, pick settings, and download finished videos. This is what lives in the `videostar` repo.
- **Backend (Framestation Linux box):** ComfyUI running LTX-Video 2.3 + Gemma 3 12B text encoder on an NVIDIA RTX PRO 4500 Blackwell sitting inside a **Thunderbolt 5 / USB4 eGPU dock**, connected to a Framework Desktop (Ryzen AI Max / Strix Halo) over a **Thunderbolt / USB4 cable** (NOT OCuLink — this was corrected in session 9).

Flow: Browser → FrameForge UI builds a ComfyUI workflow → POSTs it to ComfyUI → model runs on the Blackwell → video comes back → download. The `frame` command (`/usr/local/bin/frame`, canonical source at `scripts/frame`) is a one-word startup that kills Ollama, starts ComfyUI in tmux, starts Next.js in tmux, and tells you where to point your browser.

Why it matters: runway.ml is $35–95/mo, Sora costs tokens, both keep your prompts. FrameForge is free forever, fully private, as fast as the card can run — **once we can get the GPU to actually initialize.**

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.** Do not ask the user to re-explain setup — it's all documented here. Update the [Session Handoff](#session-handoff) section at the end of every session.

**CURRENT STATE (end of session 9 phase 1):** We have now correctly identified the topology. The RTX PRO 4500 Blackwell lives in a **Thunderbolt 5 / USB4 eGPU dock** (vendor "Micro Computer (HK) Tech. Ltd.", product name `TBGAA`, generation `USB4`), connected to a **Framework Desktop** (Ryzen AI Max / Strix Halo) whose host-side TB controller is an **Intel JHL9480 Barlow Ridge Thunderbolt 5 Bridge**. This is NOT OCuLink. Every prior session's OCuLink assumption (sessions 1–8) AND every prior session's motherboard-PCIe-slot assumption (sessions 1–7) were wrong about the physical layer. Session 9 tested all the obvious Thunderbolt-specific fixes:

- **`iommu=pt` kernel flag** (AMD IOMMU passthrough) — applied, dmesg confirms IOMMU active in passthrough mode, **RmInitAdapter error unchanged**.
- **`boltctl enroll --policy auto`** (drop strict IOMMU DMA policy on the TB device) — applied, `boltctl list` confirms `policy: auto`, link authorized at 40 Gb/s × 2 lanes = 80 Gb/s, **RmInitAdapter error unchanged byte-for-byte**.
- **Framework BIOS `mmio_uatro fch` → Port Enable + User Global Setting** — both were already Enabled. Not the problem.

The entire **DMA / IOMMU / BAR / interrupt / ASPM layer** has now been eliminated as the cause. `sudo lspci -vv -s 62:00.0` confirms BARs are assigned perfectly (Region 1 = 32 GB prefetchable at `0x2800000000`, well above 4 GB), link is authorized through boltd at full speed, the nvidia kernel module loads successfully, and then the driver fails **the moment it tries to read the GPU's config space** with `osInitNvMapping: *** Cannot attach gpu` and `RmInitAdapter failed! (0x22:0x56:894)`. `lspci -vv` shows `Unknown header type 7f` on the device, which means config reads are returning 0xFF — the card enumerates, gets BARs, then stops answering. This is no longer a host-configuration problem.

**Remaining suspects (session 10 targets):**
1. **Driver layer:** NVIDIA open kernel modules at `595.58.03` may not yet properly support Blackwell `sm_120` over a Thunderbolt tunnel. Fix candidates: add `NVreg_OpenRmEnableUnsupportedGpus=1` module parameter, OR downgrade/upgrade to the proprietary `nvidia` (non-open) branch, OR try a different driver version (580.x stable, or an even newer nightly).
2. **TB5 host ↔ USB4 dock bridge incompatibility:** The Framework Desktop's host is Thunderbolt 5 (Barlow Ridge). The dock reports `generation: USB4` (effectively TB3-class, 40 Gb/s). An NVIDIA GPU behind a generation-mismatched TB bridge chain is bleeding-edge; there are known quirks with how the Barlow Ridge bridge forwards extended config space to downstream USB4-only devices.
3. **Cold-plug vs. hot-plug ordering:** Some TB eGPU setups only initialize cleanly if the dock is powered on and connected **before** the host POSTs; others require the opposite. We have not yet tested both orderings rigorously.

**Top-10 gotchas that burn every session:**
1. **The GPU is on Thunderbolt 5 / USB4, not OCuLink and not a motherboard slot.** The Blackwell is in a TB5/USB4 dock (`TBGAA`) connected via a Thunderbolt cable to a Framework Desktop. `boltd` is in the path and must authorize the device. `boltctl list` is a first-check command every session.
2. **ComfyUI runs inside a Python venv** at `~/ComfyUI/.venv`. Always `source ~/ComfyUI/.venv/bin/activate` BEFORE any pip command.
3. **`next dev` does NOT read `PORT` from `.env.local`.** Always `PORT=3060 npm run dev`.
4. **No stray `package.json` in `/home/lynf/`** — breaks Turbopack.
5. **`ssh frame` only works from the Mac.** Alias lives in Mac's `~/.ssh/config`. On the Framestation itself, you're already there — don't run `ssh frame`.
6. **Services die when their terminal closes.** Always run them inside tmux — use the `frame` script.
7. **🔥 PyTorch CUDA version MUST match the NVIDIA driver CUDA version.** Currently `nightly/cu130` (driver CUDA 13.2).
8. **🔥 Ollama is a GPU squatter.** `sudo systemctl stop ollama` BEFORE starting ComfyUI. `frame` script handles this.
9. **🔥🔥 Default login shell is FISH, not bash.** Wrap venv commands in `bash -lc '...'`. See `scripts/frame`.
10. **🔥🔥🔥 Bootloader is systemd-boot, NOT GRUB.** Kernel cmdline lives in `/boot/loader/entries/linux-cachyos.conf` on the `options` line. File is root-only — use `sudo cat` to read, `sudo sed` to edit.

---

## Hardware (corrected AGAIN in session 9)

```
┌──────────────────────────┐        ┌────────────────────────────┐
│  Framework Desktop       │        │  TBGAA Thunderbolt/USB4    │
│  AMD Ryzen AI Max / Strix│        │  eGPU dock                 │
│  Halo                    │  TB5   │  (Micro Computer HK)       │
│  Intel JHL9480 Barlow    │◄══════►│  gen: USB4 40 Gb/s ×2      │
│  Ridge TB5 host (80/120G)│ cable  │  PCIe x16 slot             │
│  InsydeH2O BIOS 0.772    │        │  └── RTX PRO 4500 Blackwell│
│  CachyOS, systemd-boot   │        │      32 GB VRAM, sm_120    │
│  boltd authorizes device │        │      PCI 0000:62:00.0      │
└──────────────────────────┘        └────────────────────────────┘
       │
       │ LAN 192.168.4.176
       ▼
┌──────────────────┐
│  Mac (browser)   │
│  FrameForge :3060│
└──────────────────┘
```

**PCIe topology (from `lspci -tv`):**

```
[0000:00] Strix Halo Root Complex
 └─ 00:01.2 → [60:00.0] Strix Halo PCIe Bridge
              └─ [61:00.0] Intel JHL9480 TB5 Barlow Ridge (upstream)
                 ├─ [62:00.0] NVIDIA RTX PRO 4500 Blackwell (VGA)
                 ├─ [62:00.1] NVIDIA GB203 HD Audio
                 ├─ 61:01.0 / 02.0 / 03.0  Additional JHL9480 TB5 bridges
                 └─ (Strix Halo USB4 Host Router at 00:08.3 / c5:00.5/6)
```

**Why this topology matters for debugging:**
- There is a full Thunderbolt 5 / USB4 software stack (`thunderbolt` kernel module, `boltd` user daemon, `boltctl` CLI) sitting between the driver and the PCIe bus. Any of those layers can block device access even when the PCIe link itself is up.
- The **dock is `USB4` generation (40 Gb/s × 2 = 80 Gb/s effective)** while the **host is Thunderbolt 5 (Barlow Ridge, rated 80/120 Gb/s)**. This asymmetry is supported by spec but Blackwell-over-USB4-via-TB5-host is a combination with essentially zero public reports on Linux.
- `pciehp Link Down` messages we chased in sessions 1–7 come from TB's hotplug-aware PCIe forwarding, NOT an OCuLink cable.
- **Blackwell + Thunderbolt/USB4 + Linux is bleeding edge.** Most TB eGPU users on Linux run RTX 30/40-series. Blackwell on TB/USB4 on AMD Strix Halo on Linux is a combination with very few (if any) public reports.

---

## Environment facts

| Thing | Value |
|---|---|
| Hostname | `framerbox395` (Framestation) |
| **Host machine** | **Framework Desktop** (AMD Ryzen AI Max / Strix Halo, InsydeH2O BIOS 0.772) |
| **eGPU enclosure** | **TBGAA Thunderbolt 5 / USB4 eGPU dock** (Micro Computer HK; `generation: USB4`, authorized by boltd) |
| **Host TB controller** | Intel JHL9480 Barlow Ridge Thunderbolt 5 Bridge (PCI `61:00.0`) |
| OS | CachyOS (Arch-based) |
| **User default shell** | **fish** (NOT bash) |
| **Bootloader** | **systemd-boot 260.1** |
| **Boot entries** | `/boot/loader/entries/linux-cachyos.conf` (default), `linux-cachyos-lts.conf` |
| **UEFI firmware** | InsydeH2O 0.772 (F2 during POST → Setup Utility) |
| **Kernel cmdline** (end of session 9) | `... rw rootflags=subvol=/@ zswap.enabled=0 nowatchdog quiet splash pcie_aspm=off nvidia.NVreg_EnableMSI=0 iommu=pt` |
| LAN IP | `192.168.4.176` |
| SSH user | `lynf` |
| SSH from Mac | `ssh frame` (Mac-only alias, does NOT exist on the box itself) |
| FrameForge path | `/home/lynf/videostar` |
| ComfyUI path | `/home/lynf/ComfyUI` |
| ComfyUI venv | `/home/lynf/ComfyUI/.venv` (bash-only) |
| tmux sessions | `comfy`, `frame` |
| Startup shortcut | `/usr/local/bin/frame` (canonical: `scripts/frame`) |
| Firewall | `ufw` |
| Ports | 8188 (ComfyUI), 3060 (Next.js) |
| Python in venv | 3.14.3 |
| **Compute GPU** | NVIDIA RTX PRO 4500 Blackwell, 32623 MB, sm_120, PCI `62:00.0` over Thunderbolt/USB4 |
| **Display GPU** | Framework Desktop integrated (Radeon, Strix Halo iGPU), PCI `c3:00.0` |
| NVIDIA driver | **595.58.03** (CUDA 13.2) — `nvidia-open` open kernel modules |
| PyTorch | **nightly cu130** — `2.12.0.dev20260404+cu130` |
| RAM | 128 GB |
| ComfyUI | 0.18.1 |
| Ollama | `127.0.0.1:11434` — stop before ComfyUI |
| **TB device UUID** | `34158780-0022-2d02-ffff-ffffffffffff` (for `boltctl` operations) |
| **boltd policy** | `auto` (re-enrolled in session 9 from previous `iommu` policy) |

---

## URLs

| Service | URL |
|---|---|
| FrameForge | http://192.168.4.176:3060 |
| ComfyUI | http://192.168.4.176:8188 |

---

## Session Handoff

### Status as of 2026-04-05 session 9 phase 1 — Thunderbolt topology confirmed, IOMMU layer fully cleared, crash persists

Session 9 phase 1 produced three major outcomes:

**1. SECOND topology correction.** Sessions 1–7 assumed a motherboard PCIe slot. Session 8 corrected that to "Minisforum DEG2 OCuLink eGPU dock." **Session 9 corrected it again to the actual truth: Thunderbolt 5 / USB4 eGPU dock.** The user explicitly clarified mid-session: *"we are not using oculink we are using thunderbolt."* This invalidates every OCuLink-specific fix from session 8 (the BIOS `mmio_uatro fch` Port Enable / User Global Setting investigation, the "reseat the OCuLink cable" plan, the OCuLink hotplug hypothesis). `boltctl list` and `lspci -tv` confirmed the real topology: Intel JHL9480 Thunderbolt 5 Barlow Ridge host bridge → USB4-generation `TBGAA` dock → RTX PRO 4500 Blackwell.

**2. Full IOMMU / DMA / BAR layer cleared.** Applied every software fix at every layer:

- `iommu=pt` on kernel cmdline → dmesg confirms "Detected AMD IOMMU #0" in passthrough mode, IOMMU groups assigned cleanly, `RmInitAdapter failed (0x22:0x56:894)` **byte-for-byte identical**.
- `pcie_port_pm=off` removed (was hurting TB's own PCIe power-management tunneling).
- `sudo boltctl forget <uuid> && sudo boltctl enroll --policy auto <uuid>` → `boltctl list` confirms `policy: auto` (was `policy: iommu` with `key: no`). Device remains authorized at 40 Gb/s × 2 lanes. Reboot → **RmInitAdapter still fails identically.**
- `sudo lspci -vv -s 62:00.0` → BARs are *perfect*: Region 0 = 64 MB non-prefetchable at `0x80000000`, Region 1 = **32 GB prefetchable at `0x2800000000` (Resizable BAR is active, above 4 GB)**, Region 3 = 32 MB prefetchable at `0x3000000000`, Region 5 = 128 bytes of I/O. Every single byte of address space the GPU could want is handed to it correctly.
- BUT `lspci -vv` also reports `!!! Unknown header type 7f` on `62:00.0` and `Interrupt: pin ? routed to IRQ 39`. Header type `7f` / `0xff` / `?` all mean **the PCIe config space is returning all-ones** — the card enumerates at boot, the kernel writes BARs, then the GPU stops answering config reads. Driver load then fails at `osInitNvMapping` because every attempt to read the GPU's control registers gets `0xffffffff` back.

**Exact error chain from `dmesg`:**
```
nvidia 0000:62:00.0: enabling device (0000 -> 0003)
NVRM: loading NVIDIA UNIX Open Kernel Module for x86_64  595.58.03  Release Build
nvidia-modeset: Loading NVIDIA UNIX Open Kernel Mode Setting Driver for x86_64  595.58.03
[drm] [nvidia-drm] [GPU ID 0x00006200] Loading driver
NVRM: osInitNvMapping: *** Cannot attach gpu
NVRM: RmInitAdapter: osInitNvMapping failed, bailing out of RmInitAdapter
NVRM: GPU 0000:62:00.0: RmInitAdapter failed! (0x22:0x56:894)
NVRM: GPU 0000:62:00.0: rm_init_adapter failed, device minor number 0
[drm:nv_drm_dev_load [nvidia_drm]] *ERROR* [nvidia-drm] [GPU ID 0x00006200] Failed to allocate NvKmsKapiDevice
```

Notably **zero GSP-RM firmware log lines anywhere in dmesg**. The driver never gets far enough to try loading Blackwell's GSP firmware blob. This is not a firmware issue — it's a pre-firmware "card is unreachable over the TB tunnel after initial enumeration" issue.

**3. Eliminated hypotheses (definitive).**

| Layer | Status |
|---|---|
| PCIe BAR allocation | ✅ Perfect (32 GB ReBAR above 4G) |
| AMD IOMMU strict translation | ✅ Cleared (`iommu=pt`) |
| boltd IOMMU DMA policy | ✅ Cleared (`policy: auto`) |
| PCIe ASPM / power management | ✅ Cleared (`pcie_aspm=off`) |
| PCIe port power management | ✅ Cleared (removed `pcie_port_pm=off`, was hurting TB) |
| MSI-X interrupt allocation | ✅ Cleared (`nvidia.NVreg_EnableMSI=0`) |
| Thunderbolt authorization | ✅ Authorized, 40 Gb/s × 2 lanes |
| Framework BIOS MMIO Above 4G (FCH) | ✅ Port Enable + User Global Setting both already Enabled |

---

### Session 10 entry point — driver layer

The remaining suspect is the **NVIDIA driver branch itself**. The open kernel modules at `595.58.03` are effectively nightly-tier and Blackwell `sm_120` over a Thunderbolt/USB4 tunnel on AMD Strix Halo is a zero-reports-in-public combination. Two parallel fixes to try:

**Fix A — force-enable experimental/unsupported GPU paths in the open module:**
```bash
# Add NVreg_OpenRmEnableUnsupportedGpus=1 to nvidia module params
echo 'options nvidia NVreg_OpenRmEnableUnsupportedGpus=1' | sudo tee /etc/modprobe.d/nvidia-blackwell.conf
sudo mkinitcpio -P
sudo reboot
```
This tells the open module to initialize GPUs whose silicon ID isn't yet on its "fully qualified" list. Blackwell `sm_120` is new enough that some early 595 open builds gate it off by default.

**Fix B — switch from `nvidia-open` to the proprietary `nvidia` branch:**
CachyOS ships both. The proprietary module has mature Blackwell support because NVIDIA has been running Blackwell on it internally for longer than the open module. Trade-off: loses open-source kernel taint purity, gains a higher probability of `osInitNvMapping` actually succeeding.
```bash
# Rough outline — verify exact package names on CachyOS before running
sudo pacman -Rns nvidia-open nvidia-open-dkms
sudo pacman -S nvidia nvidia-utils lib32-nvidia-utils
sudo reboot
```

**Fix C (if A and B both fail) — driver version change:**
- Try 580.x stable branch (mature Blackwell).
- Try latest 599/600 nightly if one has shipped since 595.

**Fix D (hardware triage):**
- Cold-plug test: power off Framework Desktop fully, disconnect TB cable, power on Framework, wait for desktop, then plug TB cable in hot. See if hot-plug path initializes differently from cold-plug path.
- Swap test: put a non-Blackwell card (RTX 4090 if available) in the same TBGAA dock. If the 4090 initializes, it's Blackwell-specific. If it doesn't, the dock or TB chain is the problem.
- Different dock test: if another TB eGPU dock is available, try the Blackwell in it.

**Success state (same as sessions 8–9):** `nvidia-smi` shows the Blackwell at 32623 MiB, `RmInitAdapter failed` is gone from dmesg, then `frame` → tmux comfy → LTX-Video loads → generate shiba inu ice cream cone test video from http://192.168.4.176:3060.

---

### What we've conclusively eliminated across sessions 1–9

| Variable | Result |
|---|---|
| PyTorch cu128 vs cu130 | Ruled out |
| Ollama GPU squatting | Ruled out |
| fish shell venv parsing | Ruled out |
| ComfyUI-MultiGPU custom node | Ruled out |
| NVIDIA driver 595 CUDA runtime | Ruled out (failure is pre-CUDA) |
| Xid 109/119 GSP firmware | Ruled out (no Xid in dmesg, no GSP messages at all) |
| Proprietary vs open kernel module | Open is currently loaded; **proprietary NOT YET TESTED — session 10** |
| PCIe ASPM / hotplug power churn | Symptom fixed via `pcie_aspm=off`, attach still fails |
| PCIe port power management | Cleared — removed flag in session 9 (was interfering with TB tunnel) |
| MSI-X interrupt allocation | Symptom fixed via `nvidia.NVreg_EnableMSI=0`, attach still fails |
| BAR mapping / MMIO above 4G | ✅ Perfect — 32 GB ReBAR at `0x2800000000`, BIOS MMIO FCH sub-options already enabled |
| AMD IOMMU strict DMA translation | Cleared via `iommu=pt`, attach still fails |
| boltd IOMMU policy | Cleared via re-enroll with `--policy auto`, attach still fails |
| "Card is in a motherboard slot" | **WRONG (corrected session 8)** |
| "Card is in an OCuLink dock" | **WRONG (corrected session 9 — it's Thunderbolt 5 / USB4)** |
| Framework BIOS `mmio_uatro fch` Port Enable + User Global Setting | Both were already Enabled — not the cause |

**Remaining unknowns:** Driver branch (open vs proprietary), `NVreg_OpenRmEnableUnsupportedGpus=1` effect, cold-plug vs hot-plug ordering, TB5-host-to-USB4-dock bridge compatibility with Blackwell config space forwarding.

---

### Still TODO (after the stack is stable)

1. Patch `src/lib/workflow-builder.ts` to not inject `LTXVSequenceParallelMultiGPUPatcher` on single-GPU systems.
2. Patch `setup-comfyui.sh` to install PyTorch from `nightly/cu130`.
3. Patch `package.json` `"dev"` script to `"next dev -p 3060"`.
4. Verify LTX-Video 2.3 checkpoint + Gemma 3 text encoder are downloaded.
5. systemd user units for auto-start on boot.
6. Mirror kernel cmdline flags into `linux-cachyos-lts.conf` fallback entry.
7. Once the card works: remove `nvidia.NVreg_EnableMSI=0` to let MSI-X resume (better performance).
8. Rewrite first-time setup section to reflect the actual Thunderbolt topology (current setup section still references OCuLink from session 8 and needs another pass once the driver fix lands).
