// boq-decode.js — VietOCR greedy decoding, shared by the page and by the OCR workers (no DOM access here).
'use strict';

const VIETOCR_SOS = 1, VIETOCR_EOS = 2, VIETOCR_MAX_LEN = 128;

// tensor: float32 [1,3,32,W] image. vocab: array, index = token id. onYield: optional, called every 10 steps
// so a decode running on the page thread does not freeze it.
async function vietocrDecode(encSession, decSession, tensor, vocab, onYield) {
  const encResult = await encSession.run({ image: tensor });
  const memory = encResult.memory;

  const tokenIds = [VIETOCR_SOS];
  const probs = [];
  for (let step = 0; step < VIETOCR_MAX_LEN; step++) {
    const tgt = new ort.Tensor('int64', new BigInt64Array(tokenIds.map(t => BigInt(t))), [tokenIds.length, 1]);
    const decResult = await decSession.run({ tokens: tgt, memory });
    const logits = decResult.logits.data;
    tgt.dispose();

    let maxVal = -Infinity, maxIdx = 0;
    for (let j = 0; j < logits.length; j++) {
      if (logits[j] > maxVal) { maxVal = logits[j]; maxIdx = j; }
    }
    if (maxIdx === VIETOCR_EOS) { decResult.logits.dispose(); break; }
    tokenIds.push(maxIdx);

    let expSum = 0;                              // softmax probability of the chosen token = 1 / sum(exp(l - max))
    for (let j = 0; j < logits.length; j++) expSum += Math.exp(logits[j] - maxVal);
    probs.push(1.0 / expSum);
    decResult.logits.dispose();

    if (onYield && step % 10 === 9) await onYield();
  }
  memory.dispose();

  return {
    text: tokenIds.slice(1).map(id => vocab[id] || '').join(''),
    confidence: probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 0,
  };
}

if (typeof module !== 'undefined') module.exports = { vietocrDecode };
