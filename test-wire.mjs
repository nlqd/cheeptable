// Unit tests for docs/boq-wire.js (the compact model container).  Run: node test-wire.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const W = createRequire(import.meta.url)('./docs/boq-wire.js');

const lcg = (seed) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const skewed = (n, nsym, rnd) => Uint8Array.from({ length: n }, () => Math.min(nsym - 1, Math.floor(Math.abs(rnd() + rnd() - 1) ** 2.5 * nsym)));
const entropyBits = (s, nsym) => {
  const c = new Array(nsym).fill(0); s.forEach(v => c[v]++);
  return c.reduce((h, k) => (k ? h - k / s.length * Math.log2(k / s.length) : h), 0);
};
const roundTrip = (sym, nsym) => {
  const { freq, bytes } = W.encode(sym, nsym);
  const out = new Int8Array(sym.length);
  W.decode(bytes, 0, sym.length, freq, 0, out, 0);
  return { out, bytes };
};

// a container with one coded tensor, one raw fp16 tensor and one int8 rebuild, laid out the way build_wire.py writes it
function container() {
  const rnd = lcg(7);
  const R = 3, G = 2, gs = 4, n = R * G * gs;
  const codes = Int8Array.from({ length: n }, () => Math.floor(rnd() * 8) - 4);
  const steps = [0.5, 0.25, 1, 0.125, 0.5, 2];
  const coded = W.encode(Uint8Array.from(codes, c => c + 4), 8);
  const fp16 = (v) => { const b = new DataView(new ArrayBuffer(2)); b.setUint16(0, { 0.5: 0x3800, 0.25: 0x3400, 1: 0x3c00, 0.125: 0x3000, 2: 0x4000 }[v], true); return [b.getUint8(0), b.getUint8(1)]; };
  const stepBytes = Uint8Array.from(steps.flatMap(fp16));
  const payload = Uint8Array.from([...coded.bytes, ...stepBytes]);
  const head = {
    graphs: { enc: 256, encq: 256 },
    ext: { enc: ['enc'], encq: ['enc', 'encq'] },
    entries: [
      { graph: 'enc', kind: 'codes', dst: 0, n, bits: 3, off: 0, len: coded.bytes.length, freq: coded.freq },
      { graph: 'enc', kind: 'raw', dst: 64, n: steps.length, off: coded.bytes.length, len: stepBytes.length },
      { graph: 'encq', kind: 'requant', src: 'enc', qoff: 0, soff: 64, R, G, gs, dst: 0, dstS: 64 },
    ],
  };
  const h = new TextEncoder().encode(JSON.stringify(head));
  const buf = new Uint8Array(4 + h.length + payload.length);
  new DataView(buf.buffer).setUint32(0, h.length, true);
  buf.set(h, 4); buf.set(payload, 4 + h.length);
  return { buffer: buf.buffer, codes, steps, R, G, gs };
}

const tests = {
  'coded symbols come back exactly, for 2 to 64 symbols'() {
    for (const nsym of [2, 4, 8, 16, 64]) {
      const sym = skewed(20000, nsym, lcg(nsym));
      assert.deepEqual(Array.from(roundTrip(sym, nsym).out), Array.from(sym), `nsym ${nsym}`);
    }
  },
  'the coded size is within 1% of the entropy'() {
    const sym = skewed(200000, 8, lcg(3));
    const bits = roundTrip(sym, 8).bytes.length * 8 / sym.length;
    assert.ok(bits < entropyBits(sym, 8) * 1.01 + 0.001, `${bits} bits per symbol`);
  },
  'a stream of one repeated symbol still decodes'() {
    const sym = new Uint8Array(5000).fill(3);
    assert.deepEqual(Array.from(roundTrip(sym, 8).out), Array.from(sym));
  },
  'fp16 values are read correctly'() {
    assert.equal(W.half(0x3c00), 1);
    assert.equal(W.half(0xc000), -2);
    assert.equal(W.half(0x3555), 0.333251953125);
    assert.equal(W.half(0x0001), 5.960464477539063e-8);
  },
  'unpack rebuilds codes and float32 steps'() {
    const c = container();
    const { blobs } = W.unpack(c.buffer);
    assert.deepEqual(Array.from(new Int8Array(blobs.enc.buffer, 0, c.codes.length)), Array.from(c.codes));
    assert.deepEqual(Array.from(new Float32Array(blobs.enc.buffer, 64, c.steps.length)), c.steps);
  },
  'the int8 rebuild stays within half a step of the group values'() {
    const c = container();
    const { blobs } = W.unpack(c.buffer);
    const q = new Int8Array(blobs.encq.buffer, 0, c.codes.length);
    const rowStep = new Float32Array(blobs.encq.buffer, 64, c.R);
    const rowLen = c.G * c.gs;
    for (let r = 0; r < c.R; r++) {
      for (let i = 0; i < rowLen; i++) {
        const want = c.codes[r * rowLen + i] * c.steps[r * c.G + Math.floor(i / c.gs)];
        assert.ok(Math.abs(q[r * rowLen + i] * rowStep[r] - want) <= rowStep[r] / 2 + 1e-6, `row ${r} item ${i}`);
      }
    }
  },
  'asking for the float encoder alone leaves the int8 one unbuilt'() {
    const { blobs, ext } = W.unpack(container().buffer, ['enc']);
    assert.deepEqual(Object.keys(blobs), ['enc']);
    assert.deepEqual(ext.encq, ['enc', 'encq']);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
}
console.log(failed ? `${failed} failed` : `all ${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
