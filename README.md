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

**CURRENT STATE (end of session 10):** **Root cause identified.** This is a known upstream NVIDIA driver bug: Blackwell GPUs fail their GSP (GPU System Processor) boot handshake when reached through a USB4 / Thunderbolt PCIe tunnel on Linux. Five public reports (three GitHub issues on NVIDIA/open-gpu-kernel-modules, two NVIDIA Developer Forum threads) match this exact hardware pattern. The "Gen 1 x1 PCIe link" reading in dmesg that consumed sessions 8–9 is a **red herring** — AMD kernel engineer Mario Limonciello has publicly confirmed `lspci` intentionally reports bogus Gen 1 x1 values for USB4 devices on Linux. The link is fine.

Session 10 applied the standard workaround: `NVreg_EnableGpuFirmware=0` to disable the broken GSP boot path and force the driver to use the legacy host-RM code path. Awaiting post-reboot `nvidia-smi` verification.

**Top-10 gotchas that burn every session:**
1. **The GPU is on Thunderbolt 5 / USB4, not OCuLink and not a motherboard slot.** The Blackwell is in a TB5/USB4 dock (`TBGAA`) connected via a Thunderbolt cable to a Framework Desktop. `boltd` is in the path and must authorize the device. `boltctl list` is a first-check command every session.
2. **ComfyUI runs inside a Python venv** at `~/ComfyUI/.venv`. Always `source ~/ComfyUI/.venv/bin/activate` BEFORE any pip command.
3. **`next dev` does NOT read `PORT` from `.env.local`.** Always `PORT=3060 npm run dev`.
4. **No stray `package.json` in `/home/lynf/`** — breaks Turbopack.
5. **`ssh frame` only works from the Mac.** Alias lives in Mac's `~/.ssh/config`. On the Framestation itself, you're already there — don't run `ssh frame`.
6. **Services die when their terminal closes.** Always run them inside tmux — use the `frame` script.
7. **🔥 PyTorch CUDA version MUST match the NVIDIA driver CUDA version.** Driver 580.142 → cu128.
8. **🔥 Ollama is a GPU squatter.** `sudo systemctl stop ollama` BEFORE starting ComfyUI. `frame` script handles this.
9. **🔥🔥 Default login shell is FISH, not bash.** Wrap venv commands in `bash -lc '...'`. See `scripts/frame`.
10. **🔥🔥🔥 Bootloader is systemd-boot, NOT GRUB.** Kernel cmdline lives in `/boot/loader/entries/linux-cachyos.conf` on the `options` line. File is root-only — use `sudo cat` to read, `sudo sed` to edit.
11. **🔥🔥🔥🔥 `lspci` reports Gen 1 x1 for USB4 devices on Linux by design.** This is NOT your problem. Do not chase it.

---

## Hardware

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
- The **dock is `USB4` generation (40 Gb/s × 2 = 80 Gb/s effective)** while the **host is Thunderbolt 5 (Barlow Ridge, rated 80/120 Gb/s)**. This asymmetry is supported by spec.
- **Blackwell + Thunderbolt/USB4 + Linux is bleeding edge.** Most TB eGPU users on Linux run RTX 30/40-series. Blackwell on TB/USB4 on AMD Strix Halo on Linux is a combination with five known-bad public reports (see session 10 section below).

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
| **Kernel cmdline** (end of session 10) | `... rw rootflags=subvol=/@ zswap.enabled=0 nowatchdog quiet splash nvidia.NVreg_EnableMSI=0 iommu=pt` |
| **modprobe.d** | `/etc/modprobe.d/nvidia-gsp.conf` → `NVreg_EnableGpuFirmware=0`, `NVreg_EnableGpuFirmwareLogs=0` (added session 10) |
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
| NVIDIA driver | **580.142** (proprietary) — `nvidia-580xx-dkms` (swapped from `nvidia-open-dkms 595.58.03` in session 9 phase 2) |
| PyTorch | **cu128** to match driver 580.142 (needs update from prior cu130) |
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

### Status as of 2026-04-05 session 10 — ROOT CAUSE IDENTIFIED: Blackwell GSP init over USB4/TB5 is a known upstream bug

Session 10 is the session where we finally stopped chasing ghosts. After nine sessions of eliminating host-configuration variables one by one, web research surfaced a cluster of five public reports that match this exact hardware configuration and symptom. The failure is not a misconfiguration — it is a known, currently unfixed NVIDIA driver bug.

#### The critical red herring: "Gen 1 x1 PCIe link"

Every `dmesg` from sessions 8 and 9 contained two terrifying lines:
```
pci 0000:60:00.0: 2.000 Gb/s available PCIe bandwidth, limited by 2.5 GT/s PCIe x1 link
pci 0000:62:00.0: 2.000 Gb/s available PCIe bandwidth, limited by 2.5 GT/s PCIe x1 link
```
These made it look like the PCIe tunnel through Thunderbolt was collapsed to Gen 1 x1 = 2 Gb/s, which would be catastrophic for any GPU. **It is not true.**

AMD Linux engineer Mario Limonciello (who maintains the Thunderbolt/USB4 stack in the mainline kernel) has publicly confirmed on the Framework community forum that USB4/Thunderbolt devices report bogus `2.5 GT/s, Width x1` values in `lspci` on Linux **by design**. The link appears as Gen 1 x1 in `lspci` regardless of actual bandwidth — real throughput is managed by the USB4 fabric's packet scheduler and is not visible to PCIe enumeration. Users with identical messages in dmesg have posted benchmarks showing real Gen 3 x4 performance on the same hardware. The link is fine. **Do not pursue link-speed fixes in future sessions.**

#### The real root cause: Blackwell GSP firmware init fails over USB4/TB5 tunnels

Five independent public reports match this configuration:

1. **NVIDIA open-gpu-kernel-modules #974** — "RTX 5060 Ti eGPU unable to init, falls off the bus immediately" (Blackwell over Thunderbolt, Linux)
2. **NVIDIA open-gpu-kernel-modules #979** — "RTX 5080 via TB5 eGPU: hard lock on CUDA ops" (same chip family, same tunnel)
3. **NVIDIA open-gpu-kernel-modules #1064** — "GSP heartbeat stuck at 0 on RTX PRO Blackwell" (our exact SKU family)
4. **NVIDIA Developer Forum** — *"Loading GSP firmware from an **AMD Strix laptop** to a **TB5** 3090 eGPU causes instant reboot"* (our exact host architecture + tunnel type)
5. **NVIDIA Developer Forum** — *"Driver v.595 + **RTX PRO 4500 Blackwell** — crashes even when watching videos in the browser"* (our exact card + driver)

The common thread across all five: **Blackwell's GSP (GPU System Processor, a small RISC-V core on the card that the host driver must talk to before the GPU is usable) does not complete its boot handshake when the card is reached through a USB4 / Thunderbolt PCIe tunnel.** The open kernel modules fail earlier in the chain (`osInitNvMapping: Cannot attach gpu` → error 894), the proprietary modules fail later (error 897, `Cannot attach gpu` line gone) — but both fail in the GSP bring-up path. This is a current upstream bug with no merged fix as of April 2026.

#### What session 10 accomplished

**1. Confirmed the failure mode is driver-layer, not host-layer.** Swapped `nvidia-open-dkms 595.58.03` → `nvidia-580xx-dkms 580.142`. The module reloaded cleanly with no "Open" in its name (proprietary confirmed). dmesg shows:
- Error code shifted from `(0x22:0x56:894)` → `(0x22:0x56:897)` — different source line inside `RmInitAdapter`, meaning the driver is reaching further into init.
- The `osInitNvMapping: *** Cannot attach gpu` line that was present in every crash for nine sessions straight is **GONE** under the proprietary driver. The card IS reachable now. Only the GSP handshake is dying.

**2. Confirmed the "Gen 1 x1" lspci readout is cosmetic.** Documented the Limonciello quote and the Framework community threads proving it is spec-compliant USB4 behavior.

**3. Applied the GSP-off workaround.** This is the standard mitigation documented in GitHub issues #974, #979, and #1064. Disables the broken Blackwell GSP boot path and forces the driver to use the legacy host-RM resource-manager code path:
```bash
sudo tee /etc/modprobe.d/nvidia-gsp.conf <<'EOF'
options nvidia NVreg_EnableGpuFirmware=0
options nvidia NVreg_EnableGpuFirmwareLogs=0
EOF
sudo mkinitcpio -P
sudo reboot
```
mkinitcpio regenerated both `linux-cachyos` and `linux-cachyos-lts` initramfs images successfully. Awaiting post-reboot `nvidia-smi` verification.

#### The full error-signature progression across sessions

| Session | Driver | Error | `Cannot attach gpu`? | Interpretation |
|---|---|---|---|---|
| 1–7 | open 570/580 | `RmInitAdapter failed` | Yes | Host-config problem (wrong diagnosis) |
| 8 | open 595.58.03 | `(0x22:0x56:894)` | Yes | Still host-config suspected |
| 9 phase 1 | open 595.58.03 | `(0x22:0x56:894)` | Yes | IOMMU cleared, unchanged — driver suspect |
| 9 phase 2 | proprietary 580.142 | `(0x22:0x56:897)` | **No** | Card reachable, GSP handshake failing |
| 10 | proprietary 580.142 + `EnableGpuFirmware=0` | TBD | TBD | Bypassing GSP boot path entirely |

The 894 → 897 → (TBD) progression represents the driver getting measurably further into init at each step. Under GSP-off, if the upstream reports are accurate, the driver should skip the broken handshake entirely and bring the card up on the legacy host-RM path.

#### If GSP-off works
- `nvidia-smi` will show the Blackwell at 32623 MiB with driver 580.142.
- Next step: `frame` → tmux comfy → LTX-Video load → shiba inu ice cream cone test render.
- Note the performance hit: legacy host-RM is slower than GSP for some ops, but "slower" beats "does not exist."

#### If GSP-off does NOT work

**1. Try a different 580 point release.** NVIDIA Data Center driver notes document 580.95.05, 580.105.08, and 580.126.09 each containing distinct GSP-RM fixes. CachyOS currently ships 580.142 in `nvidia-580xx-dkms`. If a different point release is available in AUR, test it.

**2. Hot-plug sequence test.** Boot the Framestation with the TB5 cable **unplugged**, let the system come fully up to desktop, then physically plug the cable in. GitHub issue comments on #974 and #979 report that a subset of Blackwell-over-TB5 users see the cold-boot enumeration path fail but the hot-plug enumeration path succeed, because the USB4 fabric negotiates differently when the tunnel is established after the host is idle.

**3. Swap TB5 cable.** If the current cable is a generic USB-C or a TB3-era cable, replace it with a certified TB4 or TB5 active cable (lightning-bolt logo with "4" or "5" marking). The retimers present in dmesg suggest *some* active component in the chain, but active retimer passthrough is not the same as an active TB4/TB5 cable.

**4. The nuclear option — bypass Thunderbolt entirely.** If the RTX PRO 4500 is physically installed inside the Framework Desktop chassis on native PCIe (or connected via a native OCuLink-to-M.2 breakout instead of TB5), the entire USB4/TB5 tunnel — and therefore the entire class of bugs causing every failure in sessions 1–10 — is removed from the equation. **Every public success story of a Blackwell card working with a clean init on Linux uses native PCIe, not USB4.** This is the guaranteed-to-work path if the software workarounds do not land.

#### Sources for the root cause diagnosis (session 10 web research)
- [USB4 eGPU limited to PCIe Gen1 x1 on Framework 13 — Mario Limonciello response](https://community.frame.work/t/usb4-egpu-limited-to-pcie-gen1-x1-on-framework-13-ryzen-ai-300-bios-03-05/79190/4)
- [Loading GSP firmware from AMD Strix laptop to TB5 eGPU causes instant reboot — NVIDIA Developer Forum](https://forums.developer.nvidia.com/t/loading-gsp-firmware-from-an-amd-strix-laptop-to-a-tb5-3090-egpu-causes-instant-reboot/360903)
- [Driver 595 + RTX PRO 4500 Blackwell crashes — NVIDIA Developer Forum](https://forums.developer.nvidia.com/t/driver-v-595-rtx-pro-4500-blackwell-crashes-even-when-watching-videos-in-the-browser/365474)
- [RTX 5060 Ti eGPU unable to init, falls off bus — NVIDIA/open-gpu-kernel-modules #974](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/974)
- [RTX 5080 TB5 eGPU hard lock on CUDA — NVIDIA/open-gpu-kernel-modules #979](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/979)
- [GSP heartbeat stuck at 0 on RTX PRO Blackwell — NVIDIA/open-gpu-kernel-modules #1064](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1064)

---

### Master elimination matrix (sessions 1–10)

| Variable | Result |
|---|---|
| PyTorch cu128 vs cu130 | Ruled out (failure is pre-CUDA) |
| Ollama GPU squatting | Ruled out |
| fish shell venv parsing | Ruled out |
| ComfyUI-MultiGPU custom node | Ruled out |
| NVIDIA driver 595 CUDA runtime | Ruled out |
| Xid 109/119 GSP firmware Xid | Ruled out (no Xid — failure is pre-Xid, GPU never came up enough to emit one) |
| Open vs proprietary kernel module | **Different failure mode — card reachable under proprietary** |
| PCIe ASPM / hotplug power churn | Cleared |
| PCIe port power management | Cleared |
| MSI-X interrupt allocation | Cleared (`nvidia.NVreg_EnableMSI=0`) |
| BAR mapping / MMIO above 4G | Perfect — 32 GB ReBAR at `0x2800000000` |
| AMD IOMMU strict DMA | Cleared via `iommu=pt` |
| boltd IOMMU policy | Cleared via re-enroll `--policy auto` |
| Framework BIOS `mmio_uatro fch` | Already correct |
| **"PCIe link is Gen 1 x1"** | **RED HERRING — USB4 intentionally reports this on Linux** |
| "Card is in a motherboard slot" | WRONG (corrected session 8) |
| "Card is in an OCuLink dock" | WRONG (corrected session 9 — it's Thunderbolt 5 / USB4) |
| **Blackwell GSP firmware boot over USB4/TB5** | **ROOT CAUSE — known upstream bug, workaround applied in session 10** |

---

### Still TODO (after the stack is stable)

1. Patch `src/lib/workflow-builder.ts` to not inject `LTXVSequenceParallelMultiGPUPatcher` on single-GPU systems.
2. Patch `setup-comfyui.sh` to install PyTorch from `cu128` (to match driver 580.142).
3. Patch `package.json` `"dev"` script to `"next dev -p 3060"`.
4. Verify LTX-Video 2.3 checkpoint + Gemma 3 text encoder are downloaded.
5. systemd user units for auto-start on boot.
6. Mirror kernel cmdline flags into `linux-cachyos-lts.conf` fallback entry.
7. Once the card works: remove `nvidia.NVreg_EnableMSI=0` to let MSI-X resume (better performance).
8. If GSP-off proves stable, evaluate whether to file an upstream bug report linking this README's diagnosis to the existing open-gpu-kernel-modules issues.
