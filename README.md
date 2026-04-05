# FrameForge

> **Local AI video generation studio** — a Next.js frontend that talks to a self-hosted ComfyUI backend on a GPU machine (the "Framestation") to generate video from text prompts.

GitHub repo name is `videostar` for historical reasons. **The app is called FrameForge.**

---

## ⚠️ AI ASSISTANT: READ THIS FILE FIRST

**Every new Claude/AI session working on FrameForge must read this entire README before asking the user any setup questions.** The sections below contain everything you need to know about the environment, paths, ports, known issues, and current status. Do not ask the user to re-explain any of this — it's all documented here. Update the [Session Handoff](#session-handoff) section at the end of every work session so the next session can pick up without going in circles.

---

## Architecture

```
┌──────────────────┐     HTTP/WebSocket    ┌──────────────────────┐
│  Mac (browser)   │ ────────────────────► │  Framestation (GPU)  │
│  Safari/Chrome   │     LAN 192.168.4.x   │  CachyOS / Linux     │
└──────────────────┘                        │                      │
                                            │  ┌────────────────┐  │
                                            │  │ Next.js :3060  │  │
                                            │  │ (FrameForge UI)│  │
                                            │  └───────┬────────┘  │
                                            │          │           │
                                            │          ▼           │
                                            │  ┌────────────────┐  │
                                            │  │ ComfyUI :8188  │  │
                                            │  │ (video gen)    │  │
                                            │  └────────────────┘  │
                                            └──────────────────────┘
```

- **FrameForge (Next.js)** — this repo. Runs on port **3060**. Sends prompts to ComfyUI's REST + WS API, streams progress back to the browser, stores history locally.
- **ComfyUI** — lives on the Framestation at `/home/lynf/ComfyUI`. Runs on port **8188**. Does all the actual GPU work.
- **Both services run on the Framestation.** The Mac is just the browser.

---

## Environment facts (memorize these)

| Thing | Value |
|---|---|
| Machine name | Framestation (hostname `framerbox395`) |
| OS | CachyOS (Arch-based Linux) |
| LAN IP | `192.168.4.176` |
| SSH user | `lynf` |
| SSH from Mac | `ssh lynf@192.168.4.176` |
| FrameForge project path | `/home/lynf/videostar` |
| ComfyUI path | `/home/lynf/ComfyUI` |
| ComfyUI custom nodes | `/home/lynf/ComfyUI/custom_nodes` |
| tmux session name | `frame` (attach with `tmux attach -t frame`) |
| Firewall | `ufw` (NOT firewalld — CachyOS uses ufw) |
| Open ports | 8188/tcp (ComfyUI), 3060/tcp (Next.js) |
| Python `pip` on PATH | NO — use `python -m pip` instead |
| May need `--break-system-packages` | Sometimes, on Arch-based distros |

---

## URLs

| Service | URL (from Mac browser) |
|---|---|
| FrameForge (Next.js) | http://192.168.4.176:3060 |
| ComfyUI UI | http://192.168.4.176:8188 |
| ComfyUI WebSocket | ws://192.168.4.176:8188/ws |

---

## First-time setup (if starting from scratch)

### 1. Open the firewall (one-time)

```bash
sudo ufw allow 8188/tcp
sudo ufw allow 3060/tcp
sudo ufw reload
```

### 2. Clone and install FrameForge

```bash
cd ~
git clone https://github.com/johnfinleyproductions-lang/videostar.git
cd videostar
cp .env.example .env.local
npm install
```

### 3. Install ComfyUI custom nodes

```bash
cd ~/ComfyUI/custom_nodes
git clone https://github.com/ltdrdata/ComfyUI-Manager.git
git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git

# Install VHS Python deps (note: use `python -m pip`, not `pip`)
cd ComfyUI-VideoHelperSuite
python -m pip install -r requirements.txt
python -m pip install --force-reinstall --no-deps imageio-ffmpeg==0.6.0
python -m pip install --force-reinstall opencv-python-headless

# Verify cv2 is importable (this is the critical test)
python -c "import cv2; print('cv2 version:', cv2.__version__)"
```

If any `pip` command fails with "externally managed environment," re-run with `--break-system-packages` appended.

### 4. Clean up stray files that break Turbopack

Turbopack auto-detects the "workspace root" by looking for `package.json` / `package-lock.json` upward from the project folder. A stray one in `/home/lynf/` will cause `Can't resolve 'tailwindcss'` errors. Make sure `/home/lynf/` is clean:

```bash
ls -la /home/lynf/package.json /home/lynf/package-lock.json /home/lynf/node_modules 2>/dev/null
# If any of those exist, remove them:
rm -f /home/lynf/package.json /home/lynf/package-lock.json
rm -rf /home/lynf/node_modules
```

---

## Daily startup (normal "boot the app" flow)

SSH into the Framestation from your Mac:

```bash
ssh lynf@192.168.4.176
```

### 1. Start ComfyUI (in tmux)

```bash
tmux attach -t frame   # reattach if session exists; `tmux new -s frame` if not
cd ~/ComfyUI
python main.py --listen 0.0.0.0 --port 8188 --disable-cuda-malloc
```

Watch for: `To see the GUI go to: http://0.0.0.0:8188` and `Loaded X custom nodes` (should mention `ComfyUI-VideoHelperSuite` and `ComfyUI-Manager`).

### 2. Start FrameForge (in a new tmux window)

In the same tmux session, press `Ctrl+B` then `c` to create a new window, then:

```bash
cd ~/videostar
PORT=3060 npm run dev
```

> **Important:** `next dev` does NOT read `PORT` from `.env.local`. You must prefix the command with `PORT=3060` every time, OR update `package.json` `"dev"` script to `"next dev -p 3060"` (recommended).

Expected output:
```
Next.js 16.2.2 (Turbopack)
- Local:    http://localhost:3060
- Network:  http://192.168.4.176:3060
- Environments: .env.local
Ready in ~200ms
```

### 3. Open in Mac browser

```
http://192.168.4.176:3060
```

### tmux cheat sheet

- `Ctrl+B` then `c` — create new window (keeps current one running)
- `Ctrl+B` then `0` / `1` / `2` — switch to window 0/1/2
- `Ctrl+B` then `n` / `p` — next / previous window
- `Ctrl+B` then `d` — detach from session (leaves everything running)
- `tmux attach -t frame` — reattach to the `frame` session

---

## Known issues & solutions

| Symptom | Cause | Fix |
|---|---|---|
| Browser timeout from Mac (`ERR_CONNECTION_TIMED_OUT`) | `ufw` blocking the port | `sudo ufw allow 3060/tcp` (or 8188), `sudo ufw reload` |
| Next starts on port 3001 instead of 3060 | `next dev` ignores `PORT` in `.env.local` | Run as `PORT=3060 npm run dev`, or update the `dev` script |
| `Can't resolve 'tailwindcss' in '/home/lynf'` | Stray `package.json` / lockfile in home dir confuses Turbopack workspace detection | `rm -f /home/lynf/package.json /home/lynf/package-lock.json` then clear `.next` cache |
| `Port 3000 is in use by an unknown process` | Something else is on 3000 on the box | Not our problem — we want 3060 anyway, just use `PORT=3060` |
| ComfyUI returns `Node 'VHS_VideoCombine' not found` | VHS custom node not installed, or Python deps for VHS broken | See "Install ComfyUI custom nodes" above. Key fix: `python -m pip install --force-reinstall --no-deps imageio-ffmpeg==0.6.0` then `--force-reinstall opencv-python-headless` |
| `bash: pip: command not found` | `pip` not on PATH in CachyOS | Use `python -m pip` instead |
| `error: externally-managed-environment` | Arch/CachyOS blocks system pip | Append `--break-system-packages` to install commands |
| GPU crashes / driver hang | NVIDIA DKMS module out of sync | Reboot, let DKMS rebuild on boot |
| Multiple lockfile warning in Next | See row 3 | Same fix |

---

## Project structure

```
videostar/
├── .env.example              # copy to .env.local
├── next.config.ts            # has allowedDevOrigins for LAN IP
├── package.json              # "dev" script — add -p 3060 for stickiness
├── setup-comfyui.sh          # helper script (not required for daily use)
├── docs/
│   └── GPU-TROUBLESHOOTING.md
└── src/
    ├── app/
    │   ├── api/              # route handlers (generate, history, etc.)
    │   ├── layout.tsx
    │   ├── page.tsx
    │   └── globals.css
    ├── components/           # React UI
    ├── hooks/
    │   └── use-video-studio.ts   # main generate/history hook
    └── lib/
        ├── comfyui-client.ts     # REST + WS client for ComfyUI
        ├── workflow-builder.ts   # builds ComfyUI workflow JSON
        ├── models.ts
        ├── history.ts
        └── types.ts
```

---

## Environment variables (`.env.local`)

```env
# ComfyUI backend — always use 127.0.0.1, NEVER localhost (IPv6 issue on CachyOS)
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_WS_URL=ws://127.0.0.1:8188/ws

# App
PORT=3060
NEXT_PUBLIC_APP_URL=http://192.168.4.176:3060
NEXT_PUBLIC_COMFYUI_WS_URL=ws://192.168.4.176:8188/ws
```

> Note: `PORT=3060` in `.env.local` does NOT set the Next dev server port. It's only read by Node at runtime. Use `PORT=3060 npm run dev` OR patch `package.json`.

---

## Tech stack

- **Next.js 16.2.2** (Turbopack dev, App Router)
- **React 19.2**
- **Tailwind CSS 4**
- **Framer Motion 12**
- **Sonner** (toasts)
- **ws** (WebSocket client to ComfyUI)
- **TypeScript 5**

---

## Session Handoff

> **Update this section at the end of every session** so the next one can pick up cleanly. Short, factual, timestamped.

### Status as of 2026-04-04 (last update)

**Working:**
- ufw firewall has 8188 and 3060 open (confirmed)
- ComfyUI running on `192.168.4.176:8188`, reachable from Mac
- Next.js / FrameForge running on `192.168.4.176:3060`, UI loads in browser
- `.env.local` exists and is loaded by Next
- FrameForge successfully sends prompts to ComfyUI API (tested with "make a video of a shiba inu licking an ice cream cone")
- `ComfyUI-Manager` cloned into `~/ComfyUI/custom_nodes/ComfyUI-Manager` (not yet activated — needs ComfyUI restart)
- `ComfyUI-VideoHelperSuite` folder exists in `custom_nodes/` (cloned in a previous session)

**Blocking issue:**
- ComfyUI returns `Node 'VHS_VideoCombine' not found` when generating — VHS custom node is present as a folder but its Python dependencies (`cv2` / `opencv-python-headless`, `imageio-ffmpeg`) are NOT installed, so ComfyUI fails to register the node on startup.

**Next action (resume here):**
1. SSH into Framestation: `ssh lynf@192.168.4.176`
2. Attach tmux: `tmux attach -t frame`
3. New tmux window: `Ctrl+B` then `c`
4. Install VHS Python deps:
   ```bash
   cd ~/ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite
   python -m pip install -r requirements.txt
   python -m pip install --force-reinstall --no-deps imageio-ffmpeg==0.6.0
   python -m pip install --force-reinstall opencv-python-headless
   python -c "import cv2; print('cv2 version:', cv2.__version__)"
   ```
   If any pip step fails with "externally managed environment," add `--break-system-packages` and re-run.
5. Once `cv2 version: ...` prints successfully, restart ComfyUI (switch to its tmux window, `Ctrl+C`, then `cd ~/ComfyUI && python main.py --listen 0.0.0.0 --port 8188 --disable-cuda-malloc`)
6. Verify: reload http://192.168.4.176:8188 — a "Manager" button should now appear in the left sidebar
7. Reload http://192.168.4.176:3060 and click Generate on the shiba inu prompt — should now produce a video

**Housekeeping also done:**
- Deleted stray `/home/lynf/package-lock.json` (was confusing Turbopack workspace root)
- Confirmed `next dev` was picking `.env.local` but ignoring `PORT` var from it (documented above)

**Still TODO (after VHS works):**
- Patch `package.json` `"dev"` script to `"next dev -p 3060"` so `PORT=3060` prefix isn't needed every time
- Consider a `npm run start:all` script or systemd units to auto-start ComfyUI + Next on boot
- Add this README to the ComfyUI folder too (or symlink) so it's easy to find
