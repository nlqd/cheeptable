#!/usr/bin/env python3
"""grid_extract with a chosen encoder.  run_with_encoder.py ENC.onnx|torch PDF OUT.json [--pages 3,4]"""
import json
import sys

import grid_extract
import ortenc

enc, pdf, out = sys.argv[1:4]
pages = {int(x) for x in sys.argv[sys.argv.index("--pages") + 1].split(",")} if "--pages" in sys.argv else None
if enc != "torch":
    ortenc.install(enc)
json.dump(grid_extract.extract(pdf, pages), open(out, "w"))
