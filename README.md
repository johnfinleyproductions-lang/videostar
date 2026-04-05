# FrameForge

> **Local AI video generation studio** — a Next.js frontend that talks to a self-hosted ComfyUI backend on a GPU machine (the "Framestation") to generate video from text prompts using LTX-Video 2.3.

GitHub repo name is `videostar` for historical reasons. **The app is called FrameForge.**

---

## What FrameForge is (plain English)

FrameForge is a **local AI video generator**. You type a prompt like "shiba inu licking an ice cream cone," hit generate, and a few minutes later you get an MP4 back. No cloud fees, no sending prompts to anyone's servers, runs entirely on hardware you own.

Two halves talking over your LAN:

- **Frontend (Mac browser):** A Next.js/React web app at `http://192.168.4.176:3060` where you type prompts, pick settings, and download finished videos. This is what lives in the `videostar` repo.
- **Backend (Framestation Linux box):** ComfyUI running LTX-Video 2.3 + Gemma 3 12B text encoder on an NVIDIA RTX PRO 4500 Blackwell sitting inside a **Thunderbolt 5 / USB4 eGPU dock**, connected to a Framework Desktop (Ryzen AI Max / Strix Halo) over a Thunderbolt / USB4 cable.

Flow: Browser → FrameForge UI builds a ComfyUI workflow → POSTs it to ComfyUI → model runs on the Blackwell → video comes back → download.

Why it matters: runway.ml is $35–95/mo, Sora costs tokens, both keep your prompts. FrameForge is free forever, fully private, as fast as the card can run — **once we can get the GPU to actually initialize.**

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.** Do not ask the user to re-explain setup — it's all documented here. Update the [Session Handoff](#session-handoff) section at the end of every session.

**CURRENT STATE (end of session 11):** The RTX PRO 4500 Blackwell (PCI ID `10de:2c31`) is a GPU that **NVIDIA restricts to the open kernel modules only**. The proprietary driver branch literally prints `installed in this system requires use of the NVIDIA open kernel modules` and refuses to initialize. This invalidates sessions 9 phase 2 and 10, which both tested proprietary 580.142 and believed error `(0x22:0x56:897)` represented "the driver getting further into GSP init." It does not. Error 897 is the proprietary driver's polite way of saying "I refuse to touch this card." The "Cannot attach gpu" line disappearing wasn't progress — it was the driver bailing out earlier than `osInitNvMapping` would have run. Every Blackwell RTX PRO SKU on Linux must use `nvidia-open-dkms` — proprietary is not an option.

The correct next move: revert to `nvidia-open-dkms`, then layer the GSP-off workaround on top of it (the open modules also expose `NVreg_EnableGpuFirmware` and the GitHub issues #974/#979/#1064 workaround applies to open too). The Gen 1 x1 lspci readout remains a red herring per the session 10 findings.

**Top-11 gotchas that burn every session:**
1. **The GPU is on Thunderbolt 5 / USB4, not OCuLink and not a motherboard slot.** The Blackwell is in a TB5/USB4 dock (`TBGAA`) connected via a Thunderbolt cable to a Framework Desktop. `boltd` is in the path and must authorize the device. `boltctl list` is a first-check command every session.
2. **ComfyUI runs inside a Python venv** at `~/ComfyUI/.venv`. Always `source ~/ComfyUI/.venv/bin/activate` BEFORE any pip command.
3. **`next dev` does NOT read `PORT` from `.env.local`.** Always `PORT=3060 npm run dev`.
4. **No stray `package.json` in `/home/lynf/`** — breaks Turbopack.
5. **`ssh frame` only works from the Mac.** Alias lives in Mac's `~/.ssh/config`. On the Framestation itself, you're already there — don't run `ssh frame`.
6. **Services die when their terminal closes.** Always run them inside tmux — use the `frame` script.
7. **🔥 PyTorch CUDA version MUST match the NVIDIA driver CUDA version.** On open 595.58.03 → cu130. On open 580.x → cu128.
8. **🔥 Ollama is a GPU squatter.** `sudo systemctl stop ollama` BEFORE starting ComfyUI. `frame` script handles this.
9. **🔥🔥 Default login shell is FISH, not bash.** Wrap venv commands in `bash -lc '...'`. See `scripts/frame`.
10. **🔥🔥🔥 Bootloader is systemd-boot, NOT GRUB.** Kernel cmdline lives in `/boot/loader/entries/linux-cachyos.conf` on the `options` line. File is root-only — use `sudo cat` to read, `sudo sed` to edit.
11. **🔥🔥🔥🔥 `lspci` reports Gen 1 x1 for USB4 devices on Linux by design.** This is NOT your problem. Do not chase it.
12. **🔥🔥🔥🔥🔥 RTX PRO Blackwell REQUIRES `nvidia-open-dkms`.** Proprietary `nvidia-580xx-dkms`, `nvidia-dkms`, etc. will reject the card with `installed in this system requires use of the NVIDIA open kernel modules` and error `(0x22:0x56:897)`. There is no proprietary driver path for this SKU on Linux.

---

## Shortcuts and configuration we've installed

All of the following already exist on the Framestation from sessions 1–11. Future sessions should not re-create them unless they've been removed.

### Shell aliases and commands

| Name | Where | What it does |
|---|---|---|
| `frame` | `/usr/local/bin/frame` (symlink to `scripts/frame` in repo) | One-word startup. Stops Ollama, starts ComfyUI in tmux session `comfy`, starts Next.js in tmux session `framenext`, prints the URLs. |
| `ssh frame` | **Mac only** — `~/.ssh/config` on Tyler's Mac mini | Shortcut to `ssh lynf@192.168.4.176`. Does NOT exist on the Framestation itself. |
| `bash` | Manual invocation after SSH | Default shell is **fish**, but ComfyUI venv and most scripts assume bash. Every session starts with `ssh frame` → `bash` as the first two commands. |

### systemd-boot kernel cmdline (`/boot/loader/entries/linux-cachyos.conf`)

Current `options` line (end of session 11):
```
options root=UUID=e0a02a34-7281-4fbb-b313-adc69090b532 rw rootflags=subvol=/@ zswap.enabled=0 nowatchdog quiet splash nvidia.NVreg_EnableMSI=0 iommu=pt
```

What each flag does and why we added it:

| Flag | Session added | Purpose | Status |
|---|---|---|---|
| `zswap.enabled=0` | default install | Disable zswap (CachyOS default) | keep |
| `nowatchdog` | default install | Disable kernel watchdog | keep |
| `quiet splash` | default install | Plymouth boot splash | keep |
| `nvidia.NVreg_EnableMSI=0` | session 5 | Disable MSI-X interrupts for nvidia module (was hitting allocation failures on TB tunnel) | keep until GPU works; remove later for perf |
| `iommu=pt` | session 9 | AMD IOMMU passthrough (skip DMA translation for trusted devices) | keep |
| ~~`pcie_aspm=off`~~ | session 8, removed session 9 phase 3 | Was hurting TB link training; removed | **removed** |
| ~~`pcie_port_pm=off`~~ | session 7, removed session 9 | Was interfering with TB PCIe PM tunneling | **removed** |

**Also need to mirror these changes into `/boot/loader/entries/linux-cachyos-lts.conf`** — currently not synced, so if you boot the LTS kernel you get stale flags. Still TODO.

### modprobe.d configs (`/etc/modprobe.d/`)

| File | Content | Session | Purpose |
|---|---|---|---|
| `nvidia-gsp.conf` | `options nvidia NVreg_EnableGpuFirmware=0`<br>`options nvidia NVreg_EnableGpuFirmwareLogs=0` | 10 | Disable Blackwell GSP boot path (the known upstream bug on USB4/TB5). Confirmed present after reboot; param didn't register under proprietary 580 because proprietary rejects the card before reading modprobe params. Should take effect once we're back on open. |
| `nvidia-blackwell.conf` | `options nvidia NVreg_OpenRmEnableUnsupportedGpus=1` | 10 (Fix A attempt) | Force-enable experimental GPU IDs in the open module. Unknown if param is recognized in 595.58.03 — was previously reported "missing" from sysfs under that driver version. Leave in place; harmless if ignored. |

### boltd / Thunderbolt

| Action | Session | State |
|---|---|---|
| TB device re-enrolled with `--policy auto` instead of `--policy iommu` | 9 | Persistent — `boltctl list` shows `policy: auto` across reboots |
| TB device UUID for all `boltctl` operations | — | `34158780-0022-2d02-ffff-ffffffffffff` |
| TB device authorized state | — | `authorized` on boot, `rx/tx speed: 40 Gb/s = 2 lanes * 20 Gb/s` (USB4 generation) |

### NVIDIA driver packages (current state end of session 11)

| Package | Version | Notes |
|---|---|---|
| `nvidia-580xx-dkms` | `580.142` | **INSTALLED BUT WRONG** — proprietary rejects Blackwell RTX PRO. Must be removed in session 12. |
| ~~`nvidia-open-dkms`~~ | was `595.58.03` | **NOT INSTALLED** — removed in session 9 phase 2. Must be reinstalled in session 12. |

### Files on the Framestation (non-default locations)

| Path | Purpose |
|---|---|
| `/home/lynf/ComfyUI` | ComfyUI install |
| `/home/lynf/ComfyUI/.venv` | ComfyUI Python venv (Python 3.14.3, **bash-only** — fish does not parse the activate script correctly) |
| `/home/lynf/videostar` | FrameForge Next.js app (this repo) |
| `/usr/local/bin/frame` | Startup script (symlinks to `scripts/frame` in the repo) |
| `/mnt/rag` | btrfs subvol, currently 3.85 GB used / 1.82 TB available — unused for FrameForge, reserved |

---

## Hardware

```
┌──────────────────────────┐        ┌────────────────────────────┐
│  Framework Desktop       │        │  TBGAA Thunderbolt/USB4    │
│  AMD Ryzen AI Max+ 395   │        │  eGPU dock                 │
│  (Strix Halo, 32 cores)  │  TB5   │  (Micro Computer HK)       │
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

**PCIe topology (from `lspci -tv`):**

```
[0000:00] Strix Halo Root Complex
 └─ 00:01.2 → [60:00.0] Strix Halo PCIe Bridge
              └─ [61:00.0] Intel JHL9480 TB5 Barlow Ridge (upstream)
                 ├─ [62:00.0] NVIDIA RTX PRO 4500 Blackwell (VGA)  [PCI ID 10de:2c31]
                 ├─ [62:00.1] NVIDIA GB203 HD Audio                 [PCI ID 10de:22e9]
                 └─ 61:01.0 / 02.0 / 03.0  Additional JHL9480 TB5 bridges
```

---

## Environment facts

| Thing | Value |
|---|---|
| Hostname | `framerbox395` (Framestation) |
| Host machine | Framework Desktop (AMD Ryzen AI Max+ 395, 32 cores, Strix Halo, InsydeH2O BIOS 0.772) |
| eGPU enclosure | TBGAA Thunderbolt 5 / USB4 eGPU dock (Micro Computer HK; `generation: USB4`, authorized by boltd, `policy: auto`) |
| Host TB controller | Intel JHL9480 Barlow Ridge Thunderbolt 5 Bridge (PCI `61:00.0`) |
| Display GPU | AMD Radeon 8060S Graphics (Strix Halo iGPU, PCI `c3:00.0`) |
| Compute GPU (target) | NVIDIA RTX PRO 4500 Blackwell, 32623 MB, sm_120, PCI `62:00.0`, PCI ID `10de:2c31`, over Thunderbolt/USB4 |
| OS | CachyOS x86_64 (Arch-based) |
| Kernel (current default) | Linux 6.19.11-1-cachyos |
| Kernel (LTS fallback) | Linux 6.18.21-1-cachyos-lts |
| User default shell | fish 4.6.0 (NOT bash) |
| Bootloader | systemd-boot 260.1 |
| Boot entries | `/boot/loader/entries/linux-cachyos.conf` (default), `linux-cachyos-lts.conf` (fallback) |
| UEFI firmware | InsydeH2O 0.772 (F2 during POST → Setup Utility) |
| LAN IP | 192.168.4.176/22 on `enp191s0` |
| SSH user | `lynf` |
| SSH from Mac | `ssh frame` (Mac-only alias) |
| FrameForge path | `/home/lynf/videostar` |
| ComfyUI path | `/home/lynf/ComfyUI` |
| ComfyUI venv | `/home/lynf/ComfyUI/.venv` (bash-only) |
| tmux sessions | `comfy`, `framenext` (created by `frame` script) |
| Ports | 8188 (ComfyUI), 3060 (Next.js) |
| Python in venv | 3.14.3 |
| NVIDIA driver (end of session 11) | **580.142 proprietary — WRONG, needs swap back to open** |
| RAM | 125 GB usable (128 GB installed) |
| ComfyUI | 0.18.1 |
| Ollama | `127.0.0.1:11434` — stop before ComfyUI |
| TB device UUID | `34158780-0022-2d02-ffff-ffffffffffff` |
| boltd policy | `auto` |

---

## URLs

| Service | URL |
|---|---|
| FrameForge | http://192.168.4.176:3060 |
| ComfyUI | http://192.168.4.176:8188 |

---

## Session Handoff

### Status as of 2026-04-05 session 11 — CRITICAL CORRECTION: proprietary driver was rejecting the card, not failing GSP init

Session 11 is the session that corrected a fundamental misinterpretation from sessions 9 phase 2 and 10. We had been reading the error progression `894 → 897` as "the proprietary driver is getting further into init than the open driver." This was wrong.

#### What the dmesg actually says

Freshly-captured post-reboot dmesg from session 11 (with GSP-off modprobe config applied and `pcie_aspm=off` removed):

```
[    9.247039] nvidia 0000:62:00.0: enabling device (0000 -> 0003)
[    9.259444] [drm] [nvidia-drm] [GPU ID 0x00006200] Loading driver
[    9.260098] NVRM: The NVIDIA GPU 0000:62:00.0 (PCI ID: 10de:2c31)
               NVRM: installed in this system requires use of the NVIDIA open kernel modules.
[    9.260114] NVRM: GPU 0000:62:00.0: RmInitAdapter failed! (0x22:0x56:897)
[    9.260116] NVRM: GPU 0000:62:00.0: rm_init_adapter failed, device minor number 0
```

That middle line is the entire answer. **Error `(0x22:0x56:897)` under the proprietary 580.142 driver is not a GSP handshake failure.** It is the proprietary driver's polite way of saying "I refuse to touch this card — NVIDIA has restricted this SKU to the open kernel modules only." The `osInitNvMapping: Cannot attach gpu` line disappeared not because the card became reachable, but because the proprietary driver bails out *before* `osInitNvMapping` would run.

NVIDIA has a silicon-ID allow-list inside the proprietary module. PCI ID `10de:2c31` (RTX PRO 4500 Blackwell, GB203) is not on it. Neither are most RTX PRO Blackwell and RTX 50-series SKUs. For these cards, only `nvidia-open-dkms` is a legal choice on Linux — not by preference, by NVIDIA mandate.

#### What this means for the session 10 diagnosis

The session 10 "root cause" (Blackwell GSP boot over USB4/TB5) is still correct as the underlying problem for Blackwell-on-TB5 broadly. But the specific error-signature progression I used to justify the swap from open → proprietary was a misread:

| Driver | Error | What it really means |
|---|---|---|
| `nvidia-open-dkms 595.58.03` | `osInitNvMapping: Cannot attach gpu` → `(0x22:0x56:894)` | Open driver is trying to talk to the card over TB; GSP or config space handshake failing |
| `nvidia-580xx-dkms 580.142` | `RmInitAdapter failed (0x22:0x56:897)` + `installed in this system requires use of the NVIDIA open kernel modules` | **Proprietary flat-out refuses to load. Not a progression. Not progress.** |

Sessions 9 phase 2 and 10 were a full sidetrack. The `NVreg_EnableGpuFirmware=0` modprobe config we added in session 10 did not take effect — `cat /sys/module/nvidia/parameters/EnableGpuFirmware` returned "param missing" because the proprietary module never finished loading its parameter table. The GSP-off workaround has not actually been tested yet, because we were never on the driver it applies to.

#### Session 12 plan

**Step 1: Revert to nvidia-open-dkms.**
```bash
sudo pacman -Rns nvidia-580xx-dkms nvidia-580xx-utils nvidia-580xx-settings 2>/dev/null
# Check exact installed 580 packages first with: pacman -Qs nvidia
sudo pacman -S nvidia-open-dkms nvidia-utils
# Verify installation
pacman -Qs nvidia
```

**Step 2: Verify GSP-off modprobe config is still in place.**
```bash
cat /etc/modprobe.d/nvidia-gsp.conf
# Should show:
# options nvidia NVreg_EnableGpuFirmware=0
# options nvidia NVreg_EnableGpuFirmwareLogs=0
```

**Step 3: Verify the unsupported-GPU flag config is still in place.**
```bash
cat /etc/modprobe.d/nvidia-blackwell.conf
# Should show:
# options nvidia NVreg_OpenRmEnableUnsupportedGpus=1
```

**Step 4: Rebuild initramfs and reboot.**
```bash
sudo mkinitcpio -P
sudo reboot
```

**Step 5: After reboot, verify the open module loaded and check if the params took.**
```bash
modinfo nvidia | grep -i version        # should show 595.58.03 or newer open build
lsmod | grep nvidia                      # nvidia_drm, nvidia_modeset, nvidia, nvidia_uvm
cat /sys/module/nvidia/parameters/EnableGpuFirmware             # should now exist and read 0
cat /sys/module/nvidia/parameters/OpenRmEnableUnsupportedGpus 2>/dev/null || echo "not exposed in this build"
nvidia-smi
```

**Step 6: If `nvidia-smi` still fails, capture fresh dmesg:**
```bash
sudo dmesg | grep -iE 'nvrm|nvidia|gsp|62:00' | tail -80
```
Under open + GSP-off we should see either (a) success, or (b) a **new** error code — not 894 and not 897. A new code = new data point to act on.

**If session 12 step 5 succeeds:** Immediately run `frame` → shiba inu test. Also check PyTorch CUDA version matches the open driver's reported CUDA runtime (`nvidia-smi` top-right corner). On 595.58.03 it's CUDA 13.2 → PyTorch `nightly/cu130`.

**If session 12 step 5 fails with a new error:** Paste the dmesg and we escalate to the hot-plug sequence test (boot with TB cable unplugged, plug in after desktop loads), then a different `nvidia-open-dkms` version from AUR, then the nuclear option (physically move the card to native PCIe, bypassing Thunderbolt entirely).

#### What is now definitively known

- The "Gen 1 x1 PCIe link" in dmesg is a **red herring** — USB4 devices intentionally report bogus `2.5 GT/s Width x1` on Linux (AMD kernel engineer Mario Limonciello confirmed on Framework community forum). Do not chase link speed.
- The RTX PRO 4500 Blackwell **requires open kernel modules**. No proprietary driver path exists for this SKU. Any future "try the proprietary driver" suggestion is wrong.
- The session 10 GSP-off workaround (`NVreg_EnableGpuFirmware=0`) is the correct mitigation for Blackwell-on-USB4 GSP boot failures, but **it only applies when the driver is actually loading**, which means it must be tested on the open modules, not proprietary. Session 12 will be the first real test of it.
- The Framework Desktop has `nvidia-open-dkms` available in the standard CachyOS/Arch repos. It was previously installed at version 595.58.03 and should be reinstallable directly.

#### What is still unknown

- Whether `NVreg_EnableGpuFirmware=0` actually bypasses the GSP boot on `nvidia-open-dkms`, or whether that parameter is only meaningful on proprietary. The GitHub issues #974/#979/#1064 report it working for open users, but none of those reports are on Strix Halo.
- Whether `NVreg_OpenRmEnableUnsupportedGpus=1` is still a valid parameter in 595.58.03 — prior session 10 testing on this driver showed the param as "missing" from sysfs after reboot, suggesting the open module doesn't expose it at this version. Leave the modprobe config in place regardless — harmless if ignored.
- Whether hot-plug (boot without cable, plug in at desktop) initializes differently from cold-plug on this specific Strix Halo + TB5 + Blackwell combination. Untested.
- What cable is connecting the Framework Desktop to the TBGAA dock. Asked repeatedly across sessions 9–11, never confirmed. Could still be a generic USB-C cable in a TB5 port. The retimers in dmesg suggest *some* active element in the chain, but that doesn't guarantee a certified TB4/TB5 active cable.

---

### Full session-by-session elimination matrix

| Variable | Result |
|---|---|
| PyTorch cu128 vs cu130 | Ruled out (failure is pre-CUDA) |
| Ollama GPU squatting | Ruled out |
| fish shell venv parsing | Ruled out (always use bash for venv) |
| ComfyUI-MultiGPU custom node | Ruled out |
| NVIDIA driver 595 CUDA runtime | Ruled out |
| Xid 109/119 GSP firmware Xid | Ruled out (no Xid in any dmesg — failure is pre-Xid) |
| **Open vs proprietary kernel module** | **Proprietary REJECTS this SKU. Open is mandatory for RTX PRO Blackwell.** (session 11 correction) |
| PCIe ASPM / hotplug power churn | Cleared (`pcie_aspm=off` removed session 9 phase 3) |
| PCIe port power management | Cleared |
| MSI-X interrupt allocation | Cleared (`nvidia.NVreg_EnableMSI=0`) |
| BAR mapping / MMIO above 4G | Perfect — 32 GB ReBAR at `0x2800000000` |
| AMD IOMMU strict DMA | Cleared via `iommu=pt` |
| boltd IOMMU policy | Cleared via re-enroll `--policy auto` |
| Framework BIOS `mmio_uatro fch` | Already correct at defaults |
| **"PCIe link is Gen 1 x1"** | **RED HERRING — USB4 reports bogus values on Linux** |
| "Card is in a motherboard slot" | WRONG (corrected session 8) |
| "Card is in an OCuLink dock" | WRONG (corrected session 9) |
| "Error 894 → 897 is progress" | WRONG (corrected session 11 — 897 is driver rejection, not advancement) |
| Blackwell GSP firmware boot over USB4/TB5 | Likely root cause; mitigation not yet tested on correct driver |
| `NVreg_EnableGpuFirmware=0` on proprietary 580 | **Untested — modprobe config present but driver never loaded params because it rejects the card** |
| `NVreg_EnableGpuFirmware=0` on open 595+ | **NOT YET TESTED — session 12 target** |
| Hot-plug vs cold-plug of TB cable | Untested |
| TB5/USB4 cable identity (active TB5 vs generic USB-C) | Unknown, asked 5+ times, never confirmed |

---

### Session 10 sources (still relevant for the underlying Blackwell+USB4 GSP bug)
- [USB4 eGPU limited to PCIe Gen1 x1 on Framework 13 — Mario Limonciello response](https://community.frame.work/t/usb4-egpu-limited-to-pcie-gen1-x1-on-framework-13-ryzen-ai-300-bios-03-05/79190/4)
- [Loading GSP firmware from AMD Strix laptop to TB5 eGPU causes instant reboot — NVIDIA Developer Forum](https://forums.developer.nvidia.com/t/loading-gsp-firmware-from-an-amd-strix-laptop-to-a-tb5-3090-egpu-causes-instant-reboot/360903)
- [Driver 595 + RTX PRO 4500 Blackwell crashes — NVIDIA Developer Forum](https://forums.developer.nvidia.com/t/driver-v-595-rtx-pro-4500-blackwell-crashes-even-when-watching-videos-in-the-browser/365474)
- [RTX 5060 Ti eGPU unable to init, falls off bus — NVIDIA/open-gpu-kernel-modules #974](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/974)
- [RTX 5080 TB5 eGPU hard lock on CUDA — NVIDIA/open-gpu-kernel-modules #979](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/979)
- [GSP heartbeat stuck at 0 on RTX PRO Blackwell — NVIDIA/open-gpu-kernel-modules #1064](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1064)

---

### Still TODO (after the stack is stable)

1. **Session 12 priority 1:** Revert to `nvidia-open-dkms` and retest with GSP-off.
2. Mirror current kernel cmdline flags into `/boot/loader/entries/linux-cachyos-lts.conf` fallback entry (currently stale).
3. Patch `src/lib/workflow-builder.ts` to not inject `LTXVSequenceParallelMultiGPUPatcher` on single-GPU systems.
4. Patch `setup-comfyui.sh` to install PyTorch from the CUDA version matching the driver (cu130 for 595.x open, cu128 for 580.x open).
5. Patch `package.json` `"dev"` script to `"next dev -p 3060"`.
6. Verify LTX-Video 2.3 checkpoint + Gemma 3 text encoder are downloaded at `/home/lynf/ComfyUI/models/`.
7. systemd user units for auto-start on boot.
8. Once the card works: remove `nvidia.NVreg_EnableMSI=0` to let MSI-X resume (better performance).
9. Once the card works: consider removing `NVreg_EnableGpuFirmware=0` and retesting with GSP-on — the workaround may be leaving perf on the table for some ops.
10. File an upstream bug report on NVIDIA/open-gpu-kernel-modules linking this README's diagnosis to issues #974/#979/#1064 — our hardware combo is missing from the existing reports and could help root-cause.
11. Get the user to confirm what Thunderbolt cable is in use. Still unknown after 11 sessions.
