#!/usr/bin/env bash
# one lane of ab_all.py over the labelled table pages only, restarted until it finishes:  ab_tab_lane.sh LANE [ab_all.py options, e.g. --labcache TAG]
export RODNEY_HOME="/tmp/ab-all-rodney-$1"
cd "$(dirname "$0")/.." || exit 1
until python3 size/ab_all.py "size/ab_tab_lane$1.jsonl" --only --lane "$1" --lanes 4 "${@:2}" >> "size/ab_tab_lane$1.log" 2>&1; do sleep 5; done
