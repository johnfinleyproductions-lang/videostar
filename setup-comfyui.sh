#!/bin/bash
# ============================================================
# FrameForge — Phase 1: ComfyUI + LTX-Video 2.3 Setup
# Run this on the Framestation (ssh lynf@192.168.4.176)
# ============================================================
set -euo pipefail

echo "=========================================="
echo "  FrameForge — ComfyUI Setup Script"
echo "=========================================="

# ------------------------------------------------------------
# Step 1: Clone ComfyUI
# ------------------------------------------------------------
echo ""
echo "[1/6] Cloning ComfyUI..."
cd ~
if [ -d "ComfyUI" ]; then
    echo "  ComfyUI directory already exists, pulling latest..."
    cd ComfyUI && git pull && cd ~
else
    git clone https://github.com/comfyanonymous/ComfyUI.git
fi

# ------------------------------------------------------------
# Step 2: Create Python venv and install PyTorch nightly
# ------------------------------------------------------------
echo ""
echo "[2/6] Setting up Python venv + PyTorch nightly (Blackwell sm_120)..."
cd ~/ComfyUI

if [ ! -d ".venv" ]; then
    python -m venv .venv
fi
source .venv/bin/activate

echo "  Installing PyTorch nightly with CUDA 12.8 (for Blackwell)..."
pip install --upgrade pip
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu128

echo "  Installing ComfyUI requirements..."
pip install -r requirements.txt

# Quick CUDA sanity check
echo ""
echo "  Verifying CUDA availability..."
python -c "
import torch
print(f'  PyTorch version: {torch.__version__}')
print(f'  CUDA available: {torch.cuda.is_available()}')
if torch.cuda.is_available():
    print(f'  GPU: {torch.cuda.get_device_name(0)}')
    print(f'  VRAM: {torch.cuda.get_device_properties(0).total_mem / 1024**3:.1f} GB')
    print(f'  Compute capability: {torch.cuda.get_device_capability(0)}')
else:
    print('  WARNING: CUDA not available! Check PyTorch install.')
    print('  Try: pip install torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu130')
"

# ------------------------------------------------------------
# Step 3: Install Custom Nodes
# ------------------------------------------------------------
echo ""
echo "[3/6] Installing custom nodes..."
cd ~/ComfyUI/custom_nodes

# LTX-Video nodes
if [ ! -d "ComfyUI-LTXVideo" ]; then
    git clone https://github.com/Lightricks/ComfyUI-LTXVideo.git
    cd ComfyUI-LTXVideo && pip install -r requirements.txt && cd ..
else
    echo "  ComfyUI-LTXVideo already installed"
fi

# Video Helper Suite (VHS_VideoCombine)
if [ ! -d "ComfyUI-VideoHelperSuite" ]; then
    git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git
    cd ComfyUI-VideoHelperSuite && pip install -r requirements.txt && cd ..
else
    echo "  ComfyUI-VideoHelperSuite already installed"
fi

# ComfyUI Manager
if [ ! -d "ComfyUI-Manager" ]; then
    git clone https://github.com/ltdrdata/ComfyUI-Manager.git
else
    echo "  ComfyUI-Manager already installed"
fi

# ------------------------------------------------------------
# Step 4: Download LTX-Video 2.3 Models
# ------------------------------------------------------------
echo ""
echo "[4/6] Downloading LTX-Video 2.3 models (this may take a while)..."
cd ~/ComfyUI/models

# Install huggingface CLI if missing
pip install -q huggingface-cli 2>/dev/null || pip install -q huggingface_hub

# Main checkpoint
echo "  Downloading main checkpoint..."
cd checkpoints/
if [ ! -f "ltx-av-step-1751000_vocoder_24K.safetensors" ]; then
    huggingface-cli download Lightricks/LTX-Video \
        --include "ltx-av-step-1751000_vocoder_24K.safetensors" \
        --local-dir .
else
    echo "  Checkpoint already downloaded"
fi

# Gemma 3 text encoder (Kijai's ComfyUI-compatible version)
echo "  Downloading Gemma 3 text encoder..."
cd ../clip/
if [ ! -d "gemma-3-12b-it-qat-q4_0-unquantized_readout_proj" ]; then
    huggingface-cli download Kijai/LTX2.3_comfy --local-dir .
else
    echo "  Text encoder already downloaded"
fi

# ------------------------------------------------------------
# Step 5: Open Firewall Ports
# ------------------------------------------------------------
echo ""
echo "[5/6] Opening firewall ports (3060 for FrameForge, 8188 for ComfyUI)..."
sudo iptables -I INPUT -p tcp --dport 3060 -j ACCEPT 2>/dev/null || true
sudo iptables -I INPUT -p tcp --dport 8188 -j ACCEPT 2>/dev/null || true

# ------------------------------------------------------------
# Step 6: Test ComfyUI Startup
# ------------------------------------------------------------
echo ""
echo "[6/6] Starting ComfyUI for verification..."
echo "  Unloading any Ollama models to free VRAM..."
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"nemotron-3-nano:30b","keep_alive":0}' > /dev/null 2>&1 || true

cd ~/ComfyUI
source .venv/bin/activate

echo ""
echo "=========================================="
echo "  Setup complete!"
echo "=========================================="
echo ""
echo "  To start ComfyUI, run:"
echo "    cd ~/ComfyUI && source .venv/bin/activate"
echo "    python main.py --listen 0.0.0.0 --port 8188"
echo ""
echo "  Then verify from your Mac:"
echo "    curl http://192.168.4.176:8188/system_stats"
echo ""
echo "  ComfyUI Web UI: http://192.168.4.176:8188"
echo "  FrameForge UI:  http://192.168.4.176:3060 (after frontend deploy)"
echo ""
echo "  IMPORTANT: If CUDA failed above, try:"
echo "    pip install torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu130"
echo "=========================================="
