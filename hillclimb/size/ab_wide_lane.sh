#!/usr/bin/env bash
# one lane of ab_all.py over three pages of every born-digital document, restarted until it finishes:
#   ab_wide_lane.sh LANE NAME [ab_all.py options, e.g. --base URL --labcache TAG]      (reads go to size/wide_NAME, results to size/wide_NAME_laneLANE.jsonl)
export RODNEY_HOME="/tmp/ab-all-rodney-$1"
cd "$(dirname "$0")/.." || exit 1
until python3 size/ab_all.py "size/wide_$2_lane$1.jsonl" --lane "$1" --lanes 4 --aball "size/wide_$2" "${@:3}" >> "size/wide_$2_lane$1.log" 2>&1; do sleep 5; done
