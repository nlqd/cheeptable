#!/usr/bin/env python3
# The pickles read here were written by make_train.py on this machine, not downloaded.
"""Let the teacher read every training crop once.   label.py TRAINDIR
Writes TRAINDIR/labels.pkl: for each shard crop, the teacher's greedy token ids (including <sos>, <eos>)."""
import pickle
import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).parent))
import evalkit as E  # noqa: E402
from vietocr.tool.translate import translate  # noqa: E402

d = Path(sys.argv[1])
teacher, vocab = E.load_teacher()
teacher = teacher.to(E.DEV).eval()
labels = pickle.load(open(d / "labels.pkl", "rb")) if (d / "labels.pkl").exists() else {}
for shard in sorted(d.glob("shard*.pkl")):
    if any(k[0] == shard.name for k in labels):
        continue
    items = pickle.load(open(shard, "rb"))
    tens = [E.tensor_for(it["crop"]) for it in items]
    by_w = {}
    for i, t in enumerate(tens):
        by_w.setdefault(t.shape[-1], []).append(i)
    with torch.no_grad():
        for w, idx in by_w.items():
            for s in range(0, len(idx), 128):
                part = idx[s:s + 128]
                seqs, _ = translate(torch.stack([tens[i] for i in part]).to(E.DEV), teacher, 128, 1, 2)
                for i, sq in zip(part, seqs):
                    sq = sq.tolist()
                    sq = sq[:sq.index(2) + 1] if 2 in sq else sq
                    labels[(shard.name, i)] = sq
    print(shard.name, len(labels), flush=True)
pickle.dump(labels, open(d / "labels.pkl", "wb"))
