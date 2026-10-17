#!/usr/bin/env bash
# Names the engine scripts use but no script defines (the scripts share one global scope, so node --check cannot see this).
# Usage: hillclimb/ux/undefined_names.sh   (needs network once, for eslint)
set -euo pipefail
root=$(git rev-parse --show-toplevel)
tmp=$(mktemp --directory); cd "$tmp"
npm init -y > /dev/null; npm install --silent eslint@9 globals
cat > eslint.config.mjs <<'CFG'
import globals from 'globals';
export default [{ files: ['**/*.js'], languageOptions: { sourceType: 'script', ecmaVersion: 2022, globals: { ...globals.browser, ...globals.worker, pdfjsLib: 'readonly', ort: 'readonly', cv: 'readonly', XLSX: 'readonly', ClipperLib: 'readonly', module: 'readonly' } }, rules: { 'no-undef': 'error' } }];
CFG
cd "$root/docs"
"$tmp/node_modules/.bin/eslint" --config "$tmp/eslint.config.mjs" --format json $(ls *.js | grep --invert-match '^opencv.js$') | python3 -c "
import json, re, sys, glob
top = set()
for f in glob.glob('*.js'):
    s = open(f).read()
    top |= set(re.findall(r'^(?:async )?function\s+(\w+)', s, re.M)) | set(re.findall(r'^(?:const|let|var|class)\s+(\w+)', s, re.M))
bad = sorted({(d['filePath'].split('/')[-1], m.group(1)) for d in json.load(sys.stdin) for x in d['messages'] if (m := re.match(r\"'(\w+)' is not defined\", x['message'])) and m.group(1) not in top})
print('undefined names:', bad or 'none'); sys.exit(1 if bad else 0)"
