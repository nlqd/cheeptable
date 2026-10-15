#!/usr/bin/env bash
# Headless Chrome with a real WebGPU adapter (NVIDIA via Vulkan) on :9333, for fe_e2e.py.
mkdir --parents /tmp/vocr-chrome-profile
nohup /opt/google/chrome/chrome --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/vocr-chrome-profile \
  --enable-unsafe-webgpu --enable-features=Vulkan,UseSkiaRenderer --use-angle=vulkan --ignore-gpu-blocklist \
  --no-first-run --window-size=1400,1000 about:blank >/tmp/vocr-chrome.log 2>&1 &
