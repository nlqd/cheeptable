// wire_unpack.js DIR — decode DIR/model.bin with docs/boq-wire.js and write the external-data files (enc.bin, init.bin, step.bin) next to the skeletons.
'use strict';
const fs = require('fs'), path = require('path');
const W = require('../../docs/boq-wire.js');
const dir = process.argv[2];
const buf = fs.readFileSync(path.join(dir, 'model.bin'));
const t = Date.now();
const { blobs } = W.unpack(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
console.log('decoded in', Date.now() - t, 'ms');
for (const [g, b] of Object.entries(blobs)) fs.writeFileSync(path.join(dir, g + '.bin'), b);
