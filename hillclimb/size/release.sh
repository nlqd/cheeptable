#!/usr/bin/env bash
# release.sh NAME PLAN.json [export_student.py flags]   -- from a trained student (runs/NAME.pt) to the files the page downloads.
# Output: wire_NAME/{model.bin, enc|encq|init|step.skel.onnx}. Run from hillclimb/size. Needs calib.npz (see FINDINGS-size.md).
set -euo pipefail
name=$1; plan=$2; shift 2
../../venv_onnx_export/bin/python export_student.py "runs/$name.pt" "exp_$name" "$@"
mkdir --parents "exp_${name}_q"
../../venv_train/bin/python ../quant_encoder.py "exp_$name/encoder.onnx" calib.npz "exp_${name}_q" conv
../../venv_train/bin/python build_wire.py "exp_$name" "wire_$name" "$plan" "exp_${name}_q/enc_s_conv.onnx"
node wire_unpack.js "wire_$name"
