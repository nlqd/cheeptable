#!/usr/bin/env python3
"""Character error of student checkpoints on the held-out odd-half lines (bench3, make_train4.py --parity 1).  eval_bench3.py RUN [RUN ...]
Run from hillclimb/size with ../../venv_train/bin/python."""
import pickle, sys
from pathlib import Path
import torch
sys.path.insert(0, str(Path(__file__).parent))
import evalkit as E, kd  # noqa: E402

items = pickle.load(open("bench3/shard00.pkl", "rb"))
tens = [E.tensor_for(it["crop"]) for it in items]
for run in sys.argv[1:]:
    model, vocab = E.load_teacher()
    kd.prune(model, 1024, 6, 6); kd.prune_cnn(model, 320, [])
    model.load_state_dict(torch.load(f"runs/{run}.pt", map_location="cpu", weights_only=True))
    reads = E.read_all(model.to(E.DEV).eval(), vocab, tens)
    err = n = 0
    for it, r in zip(items, reads):
        ref = E.norm(it["ref"]); err += E.lev(ref, r); n += len(ref)
    print(run, "held-out character error", round(err / n, 4), "lines", len(items))
