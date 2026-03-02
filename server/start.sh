#!/usr/bin/env bash
# Start the hybrid OCR server (PaddleOCR 3.x detection + VietOCR recognition).
# Requires venv_paddle311 (Python 3.11 + paddleocr 3.x + vietocr).
#
# The PYTHONPATH prefix adds the system _bz2.so that the asdf Python 3.11
# build was compiled without, which torchvision (used by VietOCR) needs.
set -e
cd "$(dirname "$0")"
export PYTHONPATH="/usr/lib/python3.11/lib-dynload${PYTHONPATH:+:$PYTHONPATH}"
export PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
exec ../venv_paddle311/bin/python ocr_server.py "$@"
