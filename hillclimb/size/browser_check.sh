#!/usr/bin/env bash
# browser_check.sh NAME PLAN [release flags]  -- package a run, run the contract in the browser (CPU), print the score. serve.py on :8080 must be up.
set -u
name=$1; plan=$2; shift 2
./release.sh "$name" "$plan" "$@" 2>&1 | rg "^model.bin"
kill "$(cat /tmp/vocr-chrome.pid)" 2>/dev/null; sleep 2; rm --recursive --force /tmp/vocr-chrome-profile hosted/vietocr/cheep-v1
mkdir --parents hosted/vietocr/cheep-v1; cp "wire_$name/model.bin" wire_$name/*.skel.onnx hosted/vietocr/cheep-v1/
(nohup /opt/google/chrome/chrome --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/vocr-chrome-profile --no-first-run about:blank > /dev/null 2>&1 & echo $! > /tmp/vocr-chrome.pid); sleep 4
S=/tmp/claude-1002/-home-dungngo-dotfiles/75d68387-b15d-438e-8aee-fa26989b2717/scratchpad
(cd ../ux && timeout 290 python3 e2e.py http://localhost:8080/docs/index.html "../../7. Biểu giá HĐ.pdf" "$S/${name}_cpu.json" --port 9333 --models http://localhost:8080/hillclimb/size/hosted 2>&1 | tail --lines=1 | cut --characters=1-30)
(cd .. && ../venv_onnx_export/bin/python score.py "$S/${name}_cpu.json" --gt golden_v2.xlsx 2>&1 | tail --lines=1)
