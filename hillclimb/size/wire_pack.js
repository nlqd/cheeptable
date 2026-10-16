// wire_pack.js OUTDIR — reads pre.json + pre.bin written by build_wire.py and writes model.bin (see docs/boq-wire.js).
'use strict';
const fs = require('fs'), path = require('path');
const W = require('../../docs/boq-wire.js');
const dir = process.argv[2];
const pre = JSON.parse(fs.readFileSync(path.join(dir, 'pre.json'), 'utf8'));
const bin = fs.readFileSync(path.join(dir, 'pre.bin'));
const chunks = [], entries = [];
let off = 0;
for (const e of pre.entries) {
  const [po, pl] = e.pre || [0, 0];
  let bytes, rec = { graph: e.graph, kind: e.kind, dst: e.dst, n: e.n, off };
  if (e.kind === 'requant') { bytes = Buffer.alloc(0); rec = { ...e, off, len: 0 }; delete rec.pre; }
  else if (e.kind === 'codes') {
    const shift = 1 << (e.bits - 1);
    const sym = new Uint8Array(e.n);
    for (let i = 0; i < e.n; i++) sym[i] = (bin.readInt8(po + i) + shift);
    const enc = W.encode(sym, 1 << e.bits);
    bytes = enc.bytes; rec.bits = e.bits; rec.freq = enc.freq;
  } else bytes = bin.subarray(po, po + pl);
  rec.len = bytes.length;
  chunks.push(Buffer.from(bytes)); off += bytes.length; entries.push(rec);
}
const head = Buffer.from(JSON.stringify({ graphs: pre.graphs, ext: pre.ext, entries }));
const hl = Buffer.alloc(4); hl.writeUInt32LE(head.length);
fs.writeFileSync(path.join(dir, 'model.bin'), Buffer.concat([hl, head, ...chunks]));
console.log('header', head.length, 'bytes, payload', off, 'bytes');
