#!/usr/bin/env bash
# one lane of ab_all.py, restarted until it finishes (the output file lets it resume)
export RODNEY_HOME="/tmp/ab-all-rodney-$1"   # one browser state per lane, or the lanes read each other's files
cd "$(dirname "$0")/.." || exit 1
until python3 size/ab_all.py "size/ab_all_lane$1.jsonl" --lane "$1" --lanes 4 >> "size/ab_all_lane$1.log" 2>&1; do sleep 5; done
