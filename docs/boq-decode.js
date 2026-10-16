// boq-decode.js — VietOCR greedy decoding, shared by the page and by the OCR workers (no DOM access here).
'use strict';

const VIETOCR_SOS = 1, VIETOCR_EOS = 2, VIETOCR_MAX_LEN = 128;

// tensor: float32 [1,3,32,W] image. vocab: array, index = token id. onYield: optional, called every 10 steps
// so a decode running on the page thread does not freeze it.
// dec is either { plain: session }, which re-runs the whole sequence at every step, or { init, step }, the cached
// decoder: cross-attention keys/values are computed once per line and each step handles one token (see
// hillclimb/export_decoder_kv.py; about 2.5x faster on a whole read, same output).
async function vietocrDecode(encSession, dec, tensor, vocab, onYield) {
  const t0 = performance.now();
  const encResult = await encSession.run({ image: tensor });
  const memory = encResult.memory;
  const encMs = performance.now() - t0;

  const { tokenIds, probs } = dec.plain
    ? await _decodePlain(dec.plain, memory, onYield)
    : await _decodeCached(dec, memory, onYield);
  memory.dispose();

  return {
    text: tokenIds.slice(1).map(id => vocab[id] || '').join(''),
    confidence: probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 0,
    ms: { enc: encMs, dec: performance.now() - t0 - encMs, steps: tokenIds.length, width: tensor.dims[3] },
  };
}

// Greedy choice from one step's logits: returns { id, prob } with prob = softmax probability of the chosen token.
function _pickToken(logits) {
  let maxVal = -Infinity, maxIdx = 0;
  for (let j = 0; j < logits.length; j++) {
    if (logits[j] > maxVal) { maxVal = logits[j]; maxIdx = j; }
  }
  let expSum = 0;
  for (let j = 0; j < logits.length; j++) expSum += Math.exp(logits[j] - maxVal);
  return { id: maxIdx, prob: 1.0 / expSum };
}

async function _decodePlain(session, memory, onYield) {
  const tokenIds = [VIETOCR_SOS];
  const probs = [];
  for (let step = 0; step < VIETOCR_MAX_LEN; step++) {
    const tgt = new ort.Tensor('int64', new BigInt64Array(tokenIds.map(t => BigInt(t))), [tokenIds.length, 1]);
    const out = await session.run({ tokens: tgt, memory });
    tgt.dispose();
    const { id, prob } = _pickToken(out.logits.data);
    out.logits.dispose();
    if (id === VIETOCR_EOS) break;
    tokenIds.push(id);
    probs.push(prob);
    if (onYield && step % 10 === 9) await onYield();
  }
  return { tokenIds, probs };
}

async function _decodeCached(dec, memory, onYield) {
  const cross = await dec.init.run({ memory });
  const tokenIds = [VIETOCR_SOS];
  const probs = [];
  let pastK = new ort.Tensor('float32', new Float32Array(0), [6, 8, 0, 32]);
  let pastV = new ort.Tensor('float32', new Float32Array(0), [6, 8, 0, 32]);
  for (let step = 0; step < VIETOCR_MAX_LEN; step++) {
    const token = new ort.Tensor('int64', BigInt64Array.of(BigInt(tokenIds[tokenIds.length - 1])), [1]);
    const pos = new ort.Tensor('int64', BigInt64Array.of(BigInt(step)), [1]);
    const out = await dec.step.run({ token, pos, past_k: pastK, past_v: pastV, cross_k: cross.cross_k, cross_v: cross.cross_v });
    pastK.dispose(); pastV.dispose();
    pastK = out.new_k; pastV = out.new_v;
    const { id, prob } = _pickToken(out.logits.data);
    out.logits.dispose();
    if (id === VIETOCR_EOS) break;
    tokenIds.push(id);
    probs.push(prob);
    if (onYield && step % 10 === 9) await onYield();
  }
  pastK.dispose(); pastV.dispose();
  cross.cross_k.dispose(); cross.cross_v.dispose();
  return { tokenIds, probs };
}

if (typeof module !== 'undefined') module.exports = { vietocrDecode };
