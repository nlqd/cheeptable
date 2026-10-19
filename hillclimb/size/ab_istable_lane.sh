#!/usr/bin/env bash
# one lane of ab_istable.py, restarted until it finishes
export RODNEY_HOME="/tmp/ab-all-rodney-$1"
cd "$(dirname "$0")/.." || exit 1
until python3 size/ab_istable.py "size/ab_istable_lane$1.jsonl" --lane "$1" --lanes 4 >> "size/ab_istable_lane$1.log" 2>&1; do sleep 5; done
