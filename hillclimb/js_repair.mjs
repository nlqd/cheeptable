// node js_repair.mjs IN.json OUT.json : apply docs/boq-arith.js to extracted rows
import { createRequire } from 'node:module';
import fs from 'node:fs';
const { repairArithmetic } = createRequire(import.meta.url)('../docs/boq-arith.js');
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { fixed } = repairArithmetic(rows);
fs.writeFileSync(process.argv[3], JSON.stringify(rows));
console.log(fixed);
