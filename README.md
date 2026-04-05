# FrameForge

> **Local AI video generation studio** — a Next.js frontend that talks to a self-hosted ComfyUI backend on a GPU machine (the "Framestation") to generate video from text prompts using LTX-Video 2.3.

GitHub repo name is `videostar` for historical reasons. **The app is called FrameForge.**

---

## What FrameForge is (plain English)

FrameForge is a **local AI video generator**. You type a prompt like "shiba inu licking an ice cream cone," hit generate, and a few minutes later you get an MP4 back. No cloud fees, no sending prompts to anyone's servers, runs entirely on hardware you own.

Two halves talking over your LAN:

- **Frontend (Mac browser):** A Next.js/React web app at `http://192.168.4.176:3060` where you type prompts, pick settings, and download finished videos. This is what lives in the `videostar` repo.
- **Backend (Framestation Linux box):** ComfyUI running LTX-Video 2.3 + Gemma 3 12B text encoder on an NVIDIA RTX PRO 4500 Blackwell sitting inside a Minisforum DEG2 OCuLink eGPU enclosure, connected to a Framework Desktop (Ryzen AI Max / Strix Halo) over an OCuLink cable.

Flow: Browser → FrameForge UI builds a ComfyUI workflow → POSTs it to ComfyUI → model runs on the Blackwell → video comes back → download. The `frame` command (`/usr/local/bin/frame`, canonical source at `scripts/frame`) is a one-word startup that kills Ollama, starts ComfyUI in tmux, starts Next.js in tmux, and tells you where to point your browser.

Why it matters: runway.ml is $35–95/mo, Sora costs tokens, both keep your prompts. FrameForge is free forever, fully private, as fast as the card can run.

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.** Do not ask the user to re-explain setup — it's all documented here. Update the [Session Handoff](#session-handoff) section at the end of every session.

**CURRENT STATE (end of session 8 part 3):** Root cause localized to **Framework Desktop BIOS — MMIO Above 4G for the FCH chipset is not explicitly enabled**. The Blackwell lives in a **Minisforum DEG2 OCuLink eGPU enclosure** (NOT a motherboard slot — this is critical context that corrects sessions 1–8 guesses). The card is cabled to the Framework Desktop via OCuLink, which is a direct PCIe x4/x8 tunnel. Every prior "PCIe slot" hypothesis was wrong about the physical topology. `NVRM: RmInitAdapter failed! (0x22:0x56:894)` persists because the host BIOS can't map the Blackwell's >4GB BARs over the OCuLink link without MMIO Above 4G explicitly enabled on the FCH. Framework's InsydeH2O BIOS exposes this as a setting labeled **`mmio_uatro fch`** (likely a glitched render of "MMIO Above 4G - FCH") in the Advanced tab. Session 9 = enable it.

**Top-10 gotchas that burn every session:**
1. **The GPU is on OCuLink, not a PCIe slot.** The Blackwell is in a **Minisforum DEG2 eGPU dock** cabled to the Framework Desktop. This means host BIOS PCIe/MMIO/ReBAR settings apply to the OCuLink port, not a physical slot. Hotplug is ON by default because OCuLink is specced as hotpluggable.
2. **ComfyUI runs inside a Python venv** at `~/ComfyUI/.venv`. Always `source ~/ComfyUI/.venv/bin/activate` BEFORE any pip command.
3. **`next dev` does NOT read `PORT` from `.env.local`.** Always `PORT=3060 npm run dev`.
4. **No stray `package.json` in `/home/lynf/`** — breaks Turbopack.
5. **`ssh frame` only works from the Mac.** Alias lives in Mac's `~/.ssh/config`. On the Framestation itself, you're already there — don't run `ssh frame`.
6. **Services die when their terminal closes.** Always run them inside tmux — use the `frame` script.
7. **🔥 PyTorch CUDA version MUST match the NVIDIA driver CUDA version.** Currently `nightly/cu130` (driver CUDA 13.2).
8. **🔥 Ollama is a GPU squatter.** `sudo systemctl stop ollama` BEFORE starting ComfyUI. `frame` script handles this.
9. **🔥🔥 Default login shell is FISH, not bash.** Wrap venv commands in `bash -lc '...'`. See `scripts/frame`.
10. **🔥🔥🔥 Bootloader is systemd-boot, NOT GRUB.** Kernel cmdline lives in `/boot/loader/entries/linux-cachyos.conf` on the `options` line.

---

## Hardware (corrected in session 8 part 3)

```
┌──────────────────────────┐        ┌────────────────────────────┐
│  Framework Desktop       │        │  Minisforum DEG2 eGPU dock │
│  AMD Ryzen AI Max / Strix│◄══════►│  ATX PSU                   │
│  Halo / FCH chipset      │OCuLink │  PCIe x16 slot             │
│  InsydeH2O BIOS 0.772    │ cable  │  └── RTX PRO 4500 Blackwell│
│  /etc/modules, systemd-  │        │      32 GB VRAM, sm_120    │
│  boot, CachyOS           │        │      PCI 0000:62:00.0      │
└──────────────────────────┘        └────────────────────────────┘
       │
       │ LAN 192.168.4.176
       ▼
┌──────────────────┐
│  Mac (browser)   │
│  FrameForge :3060│
└──────────────────┘
```

**Why this topology matters for debugging:** Every prior session debugged as if the Blackwell was in a native PCIe slot. It's not. The card is in an external dock connected by a cabled PCIe link. OCuLink is very sensitive to BAR mapping, power management, and hotplug behavior compared to a native slot, and it also means:
- The DEG2 is a **passive enclosure** — no firmware translation. Whatever the Framework Desktop's BIOS gives the OCuLink port, the Blackwell sees raw.
- `pciehp Link Down` messages we saw in sessions 1–7 make sense now — OCuLink is spec'd hotpluggable, so kernel hotplug driver treats the link as if someone could yank the cable.
- **Blackwell + OCuLink + Linux is bleeding edge.** Most OCuLink eGPU users run RTX 40-series. Blackwell on OCuLink on AMD Strix Halo on Linux is a combination with very few public reports.

---

## Environment facts

| Thing | Value |
|---|---|
| Hostname | `framerbox395` (Framestation) |
| **Host machine** | **Framework Desktop** (AMD Ryzen AI Max / Strix Halo, InsydeH2O BIOS 0.772) |
| **eGPU enclosure** | **Minisforum DEG2 OCuLink dock** (direct PCIe cable, not Thunderbolt) |
| OS | CachyOS (Arch-based) |
| **User default shell** | **fish** (NOT bash) |
| **Bootloader** | **systemd-boot 260.1** |
| **Boot entries** | `/boot/loader/entries/linux-cachyos.conf` (default), `linux-cachyos-lts.conf` |
| **UEFI firmware** | InsydeH2O 0.772 (access with `F2` during POST → Setup Utility) |
| **Kernel cmdline** (current) | `... rw rootflags=subvol=/@ zswap.enabled=0 nowatchdog quiet splash pcie_aspm=off pcie_port_pm=off nvidia.NVreg_EnableMSI=0` |
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
| **Compute GPU** | NVIDIA RTX PRO 4500 Blackwell, 32623 MB, sm_120, PCI `62:00.0` over OCuLink |
| **Display GPU** | Framework Desktop integrated (Radeon, Strix Halo iGPU), PCI `c3:00.0` |
| NVIDIA driver | **595.58.03** (CUDA 13.2) — `nvidia-open` open kernel modules |
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

1. **Hardware:** Framework Desktop with Minisforum DEG2 OCuLink dock, RTX PRO 4500 Blackwell seated in the dock's PCIe slot, OCuLink cable connecting dock to the Framework Desktop.
2. **BIOS (Framework Desktop, InsydeH2O):** Enable `mmio_uatro fch` (MMIO Above 4G - FCH), Re-Size BAR if available, leave PCIe Slot Speed at Gen 4.
3. **Firewall:** `sudo ufw allow 8188/tcp && sudo ufw allow 3060/tcp && sudo ufw reload`
4. **Clone FrameForge:** `cd ~ && git clone https://github.com/johnfinleyproductions-lang/videostar.git && cd videostar && cp .env.example .env.local && npm install`
5. **ComfyUI + venv + PyTorch cu130:**
   ```bash
   cd ~ && git clone https://github.com/comfyanonymous/ComfyUI.git
   cd ComfyUI && python -m venv .venv
   bash
   source .venv/bin/activate
   pip install --upgrade pip
   pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu130
   pip install -r requirements.txt
   ```
6. **Custom nodes:**
   ```bash
   cd ~/ComfyUI/custom_nodes
   git clone https://github.com/Lightricks/ComfyUI-LTXVideo.git && cd ComfyUI-LTXVideo && pip install -r requirements.txt && cd ..
   git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git && cd ComfyUI-VideoHelperSuite && pip install -r requirements.txt && cd ..
   git clone https://github.com/ltdrdata/ComfyUI-Manager.git
   ```
7. **Models:** `huggingface-cli download Lightricks/LTX-Video` to `checkpoints/`, `Kijai/LTX2.3_comfy` to `clip/`
8. **Clean home dir:** `rm -f /home/lynf/package.json /home/lynf/package-lock.json && rm -rf /home/lynf/node_modules`
9. **Install `frame` shortcut:** `cd ~/videostar && git pull && sudo install -m 755 scripts/frame /usr/local/bin/frame`
10. **Kernel cmdline flags:** ensure `pcie_aspm=off pcie_port_pm=off` are in the systemd-boot entry options line. (See Session Handoff sed command.)

---

## Session Handoff

### Status as of 2026-04-05 session 8 part 3 — topology corrected, BIOS MMIO setting located

**Session 8 had THREE phases:**

**Part 1 — dmesg capture.** Got the actual crash fingerprint: `NVRM: RmInitAdapter failed! (0x22:0x56:894)` with `pciehp Link Down` and `D0→D3hot` during NVRM load.

**Part 2 — ASPM flags.** Added `pcie_aspm=off pcie_port_pm=off` to systemd-boot options line. Result: `Link Down` and `D0→D3hot` gone, but `RmInitAdapter failed` persisted. ASPM was a symptom, not the cause.

**Part 3 — new clue + topology correction (this part).** New dmesg showed `NVRM: GPU 0000:62:00.0: Failed to enable MSI-X.` Tried `nvidia.NVreg_EnableMSI=0` as a targeted test. Result: `Failed to enable MSI-X` gone, but `RmInitAdapter failed! (0x22:0x56:894)` persisted identically. MSI-X was also a symptom.

**Then the critical context correction:** the user clarified that the Blackwell is NOT in a motherboard slot. It's in a **Minisforum DEG2 OCuLink eGPU dock** cabled to a **Framework Desktop (AMD Ryzen AI Max / Strix Halo)**. Every prior session's "motherboard PCIe slot" hypothesis was debugging the wrong physical topology.

**Why this reframes everything:** The RmInitAdapter failure isn't a CUDA bug, isn't an NVIDIA driver bug, isn't an Xid, isn't PyTorch, isn't ComfyUI. It's the Framework Desktop BIOS failing to give the OCuLink port the MMIO space needed to map Blackwell's >4GB BARs. Blackwell cards require MMIO Above 4G to be enabled on the host chipset; on AMD platforms this is an FCH (Fusion Controller Hub) setting. Framework's InsydeH2O BIOS exposes this setting in the Advanced tab under the label **`mmio_uatro fch`** (the "uatro" is almost certainly a font/locale render glitch for "4" — "MMIO Above 4G - FCH").

**Confirmed in the Framework Desktop BIOS Advanced tab:**
- Fan Configuration
- iGPU Memory Configuration
- iGPU Memory Size
- Serial Port
- **PCIe Slot Speed — already set to Gen 4** (vendor-configured; Gen 5 known unstable)
- Force Power Supply On In Standby
- Front USB Port Speed
- Console Redirection Configuration (+ sub-items: terminal type, baud, parity, etc. — irrelevant)
- **`mmio_uatro fch`** ← THIS IS THE TARGET

**Absent from the exposed menu (may be hidden or not exposed by Framework):**
- Above 4G Decoding by that exact label
- Re-Size BAR Support
- IOMMU / AMD-Vi toggles

---

### Session 9 entry point — flip the MMIO setting

**Step 1 — Still in Framework Desktop BIOS (or reboot + F2 → Setup Utility → Advanced tab).**

**Step 2 — Arrow down to `mmio_uatro fch`, press Enter.** Read me the dropdown options before changing anything (likely `Auto / Enabled / Disabled` or `Below 4G / Above 4G`). Confirm we're flipping the right direction.

**Step 3 — Set it to the value that places MMIO above 4G** (probably `Enabled` or `Above 4G`). Save.

**Step 4 — Save and exit BIOS.** Box reboots into Linux.

**Step 5 — Verify:**
```bash
cat /proc/cmdline
sudo journalctl -k -b 0 | grep -iE "nvrm|msi|pcieport|pciehp|bar" | tail -60
nvidia-smi
```

**Success state:** `RmInitAdapter failed` is GONE. `nvidia-smi` shows the Blackwell at 32623 MiB. `No devices were found` is gone.

**Step 6 — If clean:**
```bash
frame
tmux capture-pane -t comfy -p | tail -100
```
Then open http://192.168.4.176:3060 from the Mac and finally generate the shiba inu test video.

---

### If `mmio_uatro fch` doesn't fix it — escalation ladder (OCuLink-aware)

**Escalation 1: Revert `nvidia.NVreg_EnableMSI=0`** since it didn't help and MSI-X is faster than legacy IRQs once the card is working. Keep the ASPM/PM flags.
```bash
sudo sed -i 's/ nvidia.NVreg_EnableMSI=0//' /boot/loader/entries/linux-cachyos.conf
```

**Escalation 2: Lower PCIe Slot Speed to Gen 3 in BIOS.** OCuLink cables are often the marginal component; Gen 3 gives the link error correction more headroom.

**Escalation 3: Force kernel BAR reallocation.**
```bash
sudo sed -i '/^options / s/$/ pci=realloc=on pci=assign-busses/' /boot/loader/entries/linux-cachyos.conf
```
This forces the kernel to re-lay out PCI BARs and bus numbers instead of trusting BIOS assignments. Known to help on eGPU setups where firmware pre-allocates insufficient MMIO windows.

**Escalation 4: Try the other OCuLink port on the DEG2** (if it has more than one) or reseat the OCuLink cable at both ends. OCuLink connectors are notoriously finicky about full engagement.

**Escalation 5: Swap in a non-Blackwell card** (RTX 40-series) into the DEG2 to confirm whether the DEG2 + OCuLink path works at all on this Framework Desktop. If a 4090 works and a Blackwell doesn't, we've confirmed it's a Blackwell-on-OCuLink firmware/BAR issue. If neither works, the DEG2 itself may not be fully compatible with Framework Desktop's OCuLink implementation.

**Escalation 6: Driver downgrade to 580.126.09.** Low priority now — failure is pre-driver.

**Escalation 7: Framework community.** File an issue on the Framework community forum citing `NVRM: RmInitAdapter failed! (0x22:0x56:894)` with Blackwell on DEG2 over OCuLink. Framework's BIOS team may need to expose Above 4G / ReBAR more explicitly for this use case.

---

### What we've conclusively eliminated across sessions 1–8

| Variable | Result |
|---|---|
| PyTorch cu128 vs cu130 | Ruled out |
| Ollama GPU squatting | Ruled out |
| fish shell venv parsing | Ruled out |
| ComfyUI-MultiGPU custom node | Ruled out |
| NVIDIA driver 595 CUDA runtime | Ruled out (failure is pre-CUDA) |
| Xid 109/119 GSP firmware | Ruled out (no Xid in dmesg) |
| Proprietary vs open kernel module | Confirmed correct (open is loaded) |
| PCIe ASPM / hotplug power churn | Symptom fixed via `pcie_aspm=off pcie_port_pm=off`, attach still fails |
| MSI-X interrupt allocation | Symptom fixed via `nvidia.NVreg_EnableMSI=0`, attach still fails |
| "Card is in a motherboard slot" | **WRONG — it's in a Minisforum DEG2 OCuLink eGPU dock on a Framework Desktop** |

**Remaining unknowns:** Framework Desktop BIOS MMIO Above 4G setting, OCuLink BAR size/window allocation, possible Framework-specific BIOS limitations for external eGPU use cases.

---

### Still TODO (after the stack is stable)

1. Patch `src/lib/workflow-builder.ts` to not inject `LTXVSequenceParallelMultiGPUPatcher` on single-GPU systems.
2. Patch `setup-comfyui.sh` to install PyTorch from `nightly/cu130`.
3. Patch `package.json` `"dev"` script to `"next dev -p 3060"`.
4. Verify LTX-Video 2.3 checkpoint + Gemma 3 text encoder are downloaded.
5. systemd user units for auto-start on boot.
6. Mirror kernel cmdline flags into `linux-cachyos-lts.conf` fallback entry.
7. Once the card works: remove `nvidia.NVreg_EnableMSI=0` to let MSI-X resume (better performance).
