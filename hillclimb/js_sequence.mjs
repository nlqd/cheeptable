// node js_sequence.mjs IN.json OUT.json : apply docs/boq-sequence.js then docs/boq-arith.js to extracted rows
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { repairNumbering } = require('../docs/boq-sequence.js');
const { repairArithmetic } = require('../docs/boq-arith.js');
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const a = repairNumbering(rows).fixed;
const b = repairArithmetic(rows).fixed;
fs.writeFileSync(process.argv[3], JSON.stringify(rows));
console.log('numbering fixed', a, '| arithmetic fixed', b);
