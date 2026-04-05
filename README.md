# FrameForge

> **Local AI video generation studio** — a Next.js frontend that talks to a self-hosted ComfyUI backend on a GPU machine (the "Framestation") to generate video from text prompts using LTX-Video 2.3.

GitHub repo name is `videostar` for historical reasons. **The app is called FrameForge.**

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.** Do not ask the user to re-explain setup — it's all documented here. Update the [Session Handoff](#session-handoff) section at the end of every session.

**CURRENT STATE (end of session 8):** **The root cause is a PCIe link failure at boot**, not a CUDA/driver runtime bug. `dmesg` from a crashed boot shows the Blackwell's PCIe slot reporting `Link Down` and `Card not present` during NVRM driver load, with `RmInitAdapter failed! (0x22:0x56:894)` and `pcieport 0000:61:00.0: Unable to change power state from D0 to D3hot`. This happens BEFORE any CUDA code runs — every "ComfyUI crash" so far was actually the first ioctl into an already-half-dead card. Session 8 mitigation is adding `pcie_aspm=off pcie_port_pm=off` to the kernel cmdline via systemd-boot. If that fails, force PCIe Gen 4 in BIOS. See Session Handoff.

**Top-9 gotchas that burn every session:**
1. **ComfyUI runs inside a Python venv** at `~/ComfyUI/.venv`. Always `source ~/ComfyUI/.venv/bin/activate` BEFORE any pip command.
2. **`next dev` does NOT read `PORT` from `.env.local`.** Always `PORT=3060 npm run dev`.
3. **No stray `package.json` in `/home/lynf/`** — breaks Turbopack.
4. **`ssh frame` only works from the Mac.** Alias lives in Mac's `~/.ssh/config`.
5. **Services die when their terminal closes.** Always run them inside tmux — use the `frame` script.
6. **🔥 PyTorch CUDA version MUST match the NVIDIA driver CUDA version.** Currently `nightly/cu130` (driver CUDA 13.2).
7. **🔥 Ollama is a GPU squatter.** `sudo systemctl stop ollama` BEFORE starting ComfyUI. `frame` script handles this.
8. **🔥🔥 Default login shell is FISH, not bash.** `.venv/bin/activate` is bash-syntax. Any command that sources a venv must be wrapped in `bash -lc '...'`. See `scripts/frame`.
9. **🔥🔥🔥 Bootloader is systemd-boot, NOT GRUB.** `/etc/default/grub` is empty. Kernel cmdline lives in `/boot/loader/entries/linux-cachyos.conf` on the `options` line. Backup before editing: `sudo cp /boot/loader/entries/linux-cachyos.conf /boot/loader/entries/linux-cachyos.conf.bak`.

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
| **Bootloader** | **systemd-boot 260.1** (NOT grub — `/etc/default/grub` is empty) |
| **Boot entries** | `/boot/loader/entries/linux-cachyos.conf` (default), `linux-cachyos-lts.conf` |
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
| **Compute GPU** | NVIDIA RTX PRO 4500 Blackwell, 32623 MB, sm_120, PCIe `62:00.0` (parent bridge `61:00.0`, root port `00:01.2`) |
| **Display GPU** | AMD Radeon, PCIe `c3:00.0` |
| NVIDIA driver | **595.58.03** (CUDA 13.2) |
| **NVIDIA kernel module** | **`nvidia-open`** — confirmed loaded as `NVIDIA UNIX Open Kernel Module for x86_64 595.58.03` (required for Blackwell sm_120) |
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
   # Do NOT install ComfyUI-MultiGPU — ruled out as crash cause. workflow-builder.ts still injects its node; patch workflow-builder.ts instead.
   ```
5. **Models:** `huggingface-cli download Lightricks/LTX-Video` to `checkpoints/`, `Kijai/LTX2.3_comfy` to `clip/`
6. **Clean home dir:** `rm -f /home/lynf/package.json /home/lynf/package-lock.json && rm -rf /home/lynf/node_modules`
7. **Install `frame` shortcut:** `cd ~/videostar && git pull && sudo install -m 755 scripts/frame /usr/local/bin/frame`
8. **Apply PCIe stability flags to kernel cmdline** (see Session Handoff — systemd-boot, not grub).

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
| **🔥 Framestation hard-locks within seconds of ComfyUI starting.** Every "ComfyUI crash" we've seen. | **PCIe link failure at boot.** `dmesg -k -b -1` shows `pciehp: Slot(0-1): Link Down` + `Card not present` during NVRM load, followed by `RmInitAdapter failed! (0x22:0x56:894)` and `pcieport 0000:61:00.0: Unable to change power state from D0 to D3hot`. The card silently fails to attach at boot; the first CUDA ioctl into the half-dead driver wedges the kernel. | **Session 8 fix: add `pcie_aspm=off pcie_port_pm=off` to `options` line of `/boot/loader/entries/linux-cachyos.conf`, reboot.** If that doesn't help: BIOS → force PCIe slot to Gen 4 (or Gen 3). If that doesn't help: reseat card + power cables. Driver downgrade is LAST resort (bug is below driver layer). |
| `/etc/default/grub` is empty, `sudo nano /etc/default/grub` does nothing | **Bootloader is systemd-boot, NOT grub.** | Edit `/boot/loader/entries/linux-cachyos.conf` `options` line directly. No `grub-mkconfig` needed. |
| `.venv/bin/activate (line 40): 'case' builtin not inside of switch block` | fish trying to parse bash-syntax activate script | Wrap in `bash -lc '...'` or drop into `bash` first |
| Stuck in tmux, `Ctrl+B d` does nothing | Terminal intercepts Ctrl+B | From a second SSH session: `tmux detach-client -s <name>` |
| `/usr/bin/python: No module named pip` | System Python, not venv | `source ~/ComfyUI/.venv/bin/activate` (under bash) |
| Browser `ERR_CONNECTION_REFUSED` | Service not running | `frame` |
| Next on 3001 instead of 3060 | `next dev` ignores `PORT` in `.env.local` | `PORT=3060 npm run dev` |
| ComfyUI `Node 'LTXVSequenceParallelMultiGPUPatcher' not found` | FrameForge's `workflow-builder.ts` injects it unconditionally | Patch `workflow-builder.ts` to skip on single-GPU systems. |

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

### Status as of 2026-04-04 end of session 8 — ROOT CAUSE IDENTIFIED (finally)

**Breakthrough:** Captured the exact crash fingerprint from `journalctl -k -b -1`. It is **not** an Xid. It is **not** a PyTorch bug. It is **not** a ComfyUI config. The failure happens BEFORE any of those layers run.

**The actual error chain from dmesg:**

```
NVRM: loading NVIDIA UNIX Open Kernel Module for x86_64  595.58.03
pcieport 0000:00:01.2: pciehp: Slot(0-1): Link Down
pcieport 0000:00:01.2: pciehp: Slot(0-1): Card not present     ← THE CARD VANISHES FROM THE BUS
NVRM: osInitNvMapping: *** Cannot attach gpu
NVRM: RmInitAdapter: osInitNvMapping failed, bailing out of RmInitAdapter
NVRM: GPU 0000:62:00.0: RmInitAdapter failed! (0x22:0x56:894)
NVRM: GPU 0000:62:00.0: rm_init_adapter failed, device minor number 0
pcieport 0000:61:00.0: Unable to change power state from D0 to D3hot, device inaccessible
... two seconds later ...
pcieport 0000:00:01.2: pciehp: Slot(0-1): Card present
pcieport 0000:00:01.2: pciehp: Slot(0-1): Link Up
```

**Translation:** The moment the NVIDIA driver tries to initialize the Blackwell (`NVRM: loading...`), the PCIe hotplug controller on root port `0000:00:01.2` reports the slot as `Link Down` and `Card not present`. The card physically drops off the bus mid-driver-attach. `RmInitAdapter` fails with error code `(0x22:0x56:894)`. Two seconds later the slot comes back up, but NVRM has already given up. For the rest of the boot session, the card is in limbo — `nvidia-smi` may even appear to work — and the first real ioctl into the driver (from `import torch`, ComfyUI, or anything that touches CUDA) wedges the kernel and kills SSH.

**This is PCIe link training instability, not a driver bug.** The previous sessions' Xid/GSP/driver-downgrade hypothesis was wrong. The card never even gets to a state where Xid errors could happen. We've been debugging the wrong layer for 8 sessions.

**Why this is actually great news:**
- It's a hardware-link-level problem, which has well-known Linux mitigations (PCIe ASPM/PM flags, BIOS generation forcing, reseating).
- It explains why PyTorch upgrades, cu128→cu130, MultiGPU removal, Ollama stopping, and every other ComfyUI-layer change did nothing — none of them were anywhere near the problem.
- Open kernel module is confirmed loaded correctly (`NVIDIA UNIX Open Kernel Module`), so that's one less rabbit hole.

**Confirmed environment facts from session 8:**
- Bootloader is **systemd-boot 260.1**, not GRUB. `/etc/default/grub` is empty. Kernel cmdline lives in `/boot/loader/entries/linux-cachyos.conf` on the `options` line.
- Default entry is `linux-cachyos.conf`, fallback is `linux-cachyos-lts.conf`.
- Current `/proc/cmdline` before the fix: `initrd=\initramfs-linux-cachyos.img root=UUID=e0a02a34-7281-4fbb-b313-adc69090b532 rw rootflags=subvol=/@ zswap.enabled=0 nowatchdog quiet splash`
- Backup of the conf was created at `/boot/loader/entries/linux-cachyos.conf.bak` during session 8.

---

### Session 9 entry point — apply the fix, verify, run the stack

**Step 1 — Apply PCIe stability flags** (the sed is safe because there's exactly one `options` line in the file; backup was created in session 8):
```bash
sudo sed -i '/^options / s/$/ pcie_aspm=off pcie_port_pm=off/' /boot/loader/entries/linux-cachyos.conf
sudo cat /boot/loader/entries/linux-cachyos.conf
```
Verify the `options` line now ends with `... nowatchdog quiet splash pcie_aspm=off pcie_port_pm=off`.

**Step 2 — Reboot:**
```bash
sudo reboot
```

**Step 3 — After reboot, verify the fix landed and the bus stayed up:**
```bash
ssh frame
bash
cat /proc/cmdline                                                          # should show new flags
sudo journalctl -k -b 0 | grep -iE "xid|nvrm|pcieport|pciehp" | tail -80  # should NOT show "Link Down" / "Card not present" / "RmInitAdapter failed"
nvidia-smi                                                                 # should show Blackwell clean at 32623 MB
```

**Step 4 — If all three are clean, run the stack:**
```bash
frame
tmux capture-pane -t comfy -p | tail -80
```
Watch for ComfyUI to finish startup without wedging the box. If it does finish startup, open http://192.168.4.176:3060 from the Mac and try generating the shiba inu test video.

---

### If the fix doesn't work — escalation ladder

**Escalation 1: Disable PCIe hotplug entirely.**
If dmesg still shows `pciehp: Slot(0-1): Link Down` after the ASPM/PM flags, the hotplug driver is still power-cycling the slot. Add `pci=nomsi` and/or blacklist `pciehp`:
```bash
sudo sed -i '/^options / s/$/ pci=noaer pciehp.pciehp_force=0/' /boot/loader/entries/linux-cachyos.conf
# Or, more aggressively, blacklist the pciehp module:
echo "blacklist pciehp" | sudo tee /etc/modprobe.d/blacklist-pciehp.conf
sudo mkinitcpio -P
sudo reboot
```

**Escalation 2: Force PCIe Gen 4 in BIOS.**
Reboot into UEFI (tap `F2` or `Del` during POST — this is an INSYDE firmware per `bootctl status`). Navigate to PCIe configuration. Find the slot containing the Blackwell (PCIe `62:00.0`, usually "PCIE Slot 1" or similar). Change the link speed from `Auto` / `Gen 5` to `Gen 4`. Save and reboot. Re-verify with `journalctl -k -b 0`. If Gen 4 still drops, try Gen 3.

**Escalation 3: Reseat + power.**
Power off, unplug. Remove the card, inspect the PCIe fingers and slot for debris. Reseat firmly until the retention clip clicks. Unplug and replug both 12VHPWR / PCIe power connectors on the card AND at the PSU. Check the PSU wattage — RTX PRO 4500 Blackwell is ~200W TBP with significant transient spikes; a marginal PSU can cause link training failures.

**Escalation 4: Driver downgrade to 580.126.09.**
Only do this if 1–3 all fail. The web-research path from session 7 is still valid as a last resort, but it's no longer the leading hypothesis:
```bash
pacman -Ss nvidia-open
sudo downgrade nvidia-open nvidia-utils nvidia-settings
sudo mkinitcpio -P
sudo sed -i 's/^#IgnorePkg.*/IgnorePkg = nvidia-open nvidia-utils nvidia-settings/' /etc/pacman.conf
sudo reboot
```

**Escalation 5: Swap the card** into a different PCIe slot, or test with a non-Blackwell GPU to prove the failure is card-specific vs slot-specific vs motherboard-specific.

---

### What we've conclusively eliminated across sessions 1–8

| Variable | How it was tested | Result |
|---|---|---|
| PyTorch cu128 vs cu130 | Upgraded to nightly cu130 | Ruled out |
| Ollama GPU squatting | `sudo systemctl stop ollama` via frame script | Ruled out |
| fish shell parsing `.venv/bin/activate` | Wrapped in `bash -lc` | Ruled out |
| ComfyUI-MultiGPU custom node | Parked out of `custom_nodes/`, crash persisted | Ruled out |
| NVIDIA driver 595 CUDA runtime bug | dmesg shows failure is at PCIe layer, before any CUDA | Ruled out (for now) |
| Xid 109/119 GSP firmware crash | dmesg shows ZERO Xid entries — crash is pre-Xid | Ruled out |
| Proprietary vs open kernel module | dmesg confirms `NVIDIA UNIX Open Kernel Module` | Correct one is loaded |

**Session 8's actual contribution:** Got the dmesg from a crashed boot. That's the artifact we'd been missing. Every prior session was guessing because we had no kernel-side evidence — only the symptom (SSH dying).

---

### Still TODO (after the stack is stable)

1. Patch `src/lib/workflow-builder.ts` to not inject `LTXVSequenceParallelMultiGPUPatcher` on single-NVIDIA-GPU systems.
2. Patch `setup-comfyui.sh` to install PyTorch from `nightly/cu130`.
3. Patch `package.json` `"dev"` script to `"next dev -p 3060"`.
4. Verify LTX-Video 2.3 checkpoint + Gemma 3 text encoder are downloaded.
5. systemd user units for auto-start on boot.
6. Bake the `pcie_aspm=off pcie_port_pm=off` flags into the `linux-cachyos-lts.conf` fallback entry too, so rescue-boot stays stable.
