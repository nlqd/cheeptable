// boq-wire.js — the compact model file. Weights travel as 2-6 bit integer codes with one fp16 step per group of weights,
// entropy coded with a static rANS coder; the page rebuilds the plain int8 / float32 arrays ONNX Runtime reads as external data.
// Works in the page, in a worker (importScripts) and in node (the packer and the tests).
'use strict';

const CTWire = (() => {
  const PB = 14, M = 1 << PB, LOW = 1 << 23;

  // counts -> frequencies that sum to M, every present symbol at least 1
  function normalise(counts) {
    const total = counts.reduce((a, b) => a + b, 0);
    const f = counts.map(c => (c ? Math.max(1, Math.round(c * M / total)) : 0));
    let diff = M - f.reduce((a, b) => a + b, 0);
    const order = f.map((v, i) => i).sort((a, b) => f[b] - f[a]);
    for (let k = 0; diff !== 0; k = (k + 1) % order.length) {
      const i = order[k];
      if (diff > 0) { f[i]++; diff--; } else if (f[i] > 1) { f[i]--; diff++; }
    }
    return f;
  }

  // symbols: Uint8Array of symbol indices; returns { freq, bytes }
  function encode(symbols, nsym) {
    const counts = new Array(nsym).fill(0);
    for (let i = 0; i < symbols.length; i++) counts[symbols[i]]++;
    const freq = normalise(counts);
    const cum = new Array(nsym + 1).fill(0);
    for (let s = 0; s < nsym; s++) cum[s + 1] = cum[s] + freq[s];
    const out = [];
    let x = LOW;
    for (let i = symbols.length - 1; i >= 0; i--) {
      const s = symbols[i], f = freq[s];
      const xmax = (LOW >>> PB << 8) * f;
      while (x >= xmax) { out.push(x & 255); x = x >>> 8; }
      x = Math.floor(x / f) * M + (x % f) + cum[s];
    }
    for (let k = 0; k < 4; k++) { out.push(x & 255); x = x >>> 8; }
    out.reverse();
    return { freq, bytes: Uint8Array.from(out) };
  }

  // reads n symbols from bytes[offset..]; writes symbol - shift into out (Int8Array)
  function decode(bytes, offset, n, freq, shift, out, outOffset) {
    const nsym = freq.length;
    const cum = new Uint32Array(nsym + 1);
    for (let s = 0; s < nsym; s++) cum[s + 1] = cum[s] + freq[s];
    const slot2sym = new Uint8Array(M);
    for (let s = 0; s < nsym; s++) slot2sym.fill(s, cum[s], cum[s + 1]);
    let p = offset;
    let x = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
    p += 4;
    for (let i = 0; i < n; i++) {
      const slot = x & (M - 1), s = slot2sym[slot];
      out[outOffset + i] = s - shift;
      x = freq[s] * (x >>> PB) + slot - cum[s];
      while (x < LOW) x = ((x << 8) | bytes[p++]) >>> 0;
    }
    return p;
  }

  function half(h) {
    const e = (h >> 10) & 31, m = h & 1023, sign = h & 0x8000 ? -1 : 1;
    if (e === 0) return sign * m * 5.960464477539063e-8;
    if (e === 31) return m ? NaN : sign * Infinity;
    return sign * (1 + m / 1024) * Math.pow(2, e - 15);
  }

  // The sinusoidal positional table of the transformer (torch's PositionalEncoding), written as float32.
  function positional(e, blob) {
    const out = new Float32Array(blob.buffer, e.dst, e.rows * e.d);
    for (let p = 0; p < e.rows; p++) {
      for (let i = 0; i < e.d; i += 2) {
        const a = p * Math.exp(i * (-Math.log(10000) / e.d));
        out[p * e.d + i] = Math.sin(a);
        out[p * e.d + i + 1] = Math.cos(a);
      }
    }
  }

  // Rebuild a convolution weight as int8 with one step per output channel (what the quantised encoder graph holds) from the
  // group codes and steps already decoded into the shared blob. Row step = largest weight / 127.
  function requant(e, srcBlob, blob) {
    const codes = new Int8Array(srcBlob.buffer, e.qoff, e.R * e.G * e.gs);
    const steps = new Float32Array(srcBlob.buffer, e.soff, e.R * e.G);
    const out = new Int8Array(blob.buffer, e.dst, e.R * e.G * e.gs);
    const rowStep = new Float32Array(blob.buffer, e.dstS, e.R);
    const rowLen = e.G * e.gs;
    for (let r = 0; r < e.R; r++) {
      let amax = 0;
      for (let g = 0; g < e.G; g++) {
        let m = 0;
        const base = r * rowLen + g * e.gs;
        for (let i = 0; i < e.gs; i++) { const c = codes[base + i]; const a = c < 0 ? -c : c; if (a > m) m = a; }
        const v = m * steps[r * e.G + g];
        if (v > amax) amax = v;
      }
      const step = amax > 0 ? Math.fround(amax / 127) : 1;
      rowStep[r] = step;
      for (let g = 0; g < e.G; g++) {
        const s = steps[r * e.G + g] / step, base = r * rowLen + g * e.gs;
        for (let i = 0; i < e.gs; i++) {
          const q = Math.round(codes[base + i] * s);
          out[base + i] = q > 127 ? 127 : q < -127 ? -127 : q;
        }
      }
    }
  }

  // model.bin = u32 header length, JSON header, payload. `want`: the graphs the caller will open (any of enc, encq, init, step).
  // Returns { blobs, ext }: blobs[name] is the Uint8Array holding the external data file `name.bin`, ext[graph] the files a graph reads.
  function unpack(buffer, want) {
    const dv = new DataView(buffer);
    const hlen = dv.getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, hlen)));
    const payload = new Uint8Array(buffer, 4 + hlen);
    const needed = new Set((want || Object.keys(head.ext)).flatMap(g => head.ext[g]));
    const blobs = {};
    for (const g of needed) blobs[g] = new Uint8Array(head.graphs[g]);
    for (const e of head.entries) {
      if (!needed.has(e.graph)) continue;
      const blob = blobs[e.graph];
      if (e.kind === 'codes') {
        decode(payload, e.off, e.n, e.freq, 1 << (e.bits - 1), new Int8Array(blob.buffer), e.dst);
      } else if (e.kind === 'pe') {
        positional(e, blob);
      } else if (e.kind === 'requant') {
        requant(e, blobs[e.src], blob);
      } else {                                           // fp16 values stored raw, written as float32
        const out = new Float32Array(blob.buffer, e.dst, e.n);
        const base = e.off;
        for (let i = 0; i < e.n; i++) out[i] = half(payload[base + 2 * i] | (payload[base + 2 * i + 1] << 8));
      }
    }
    return { blobs, ext: head.ext };
  }

  return { encode, decode, unpack, normalise, half };
})();

if (typeof module !== 'undefined') module.exports = CTWire;
