#!/usr/bin/env bash
# usage: run_parity.sh OUT.json  -- runs browser_parity.js on WASM against the current docs/boq-onnx.js, cache cleared
set -u
rodney clear-cache >/dev/null 2>&1
rodney open http://localhost:8080/docs/index.html >/dev/null 2>&1
rodney reload --hard >/dev/null 2>&1
sleep 3
echo "in-page VIETOCR_PAD_PX = $(rodney js 'VIETOCR_PAD_PX' 2>&1 | tail --lines=1)"
rodney js "(() => { Object.defineProperty(navigator, 'gpu', {value: undefined, configurable: true}); window._parityDone=false; window._parity=[]; window._p = $(tr '\n' ' ' < browser_parity.js); return 'started'; })()" >/dev/null 2>&1
until [ "$(rodney js 'window._parityDone' 2>&1 | tail --lines=1)" = "true" ]; do sleep 8; done
rodney js "JSON.stringify(window._parity)" 2>&1 | tail --lines=1 > "$1"
