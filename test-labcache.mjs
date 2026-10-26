// node test-labcache.mjs: the key the lab's read cache files a crop under.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { labTensorKey } = createRequire(import.meta.url)('./docs/boq-utils.js');
const tensor = (fill) => Float32Array.from({ length: 3 * 32 * 40 }, (_, i) => fill(i));
const tests = {
  'the same pixels give the same key'() {
    assert.equal(labTensorKey(tensor(i => i % 7 / 7), 40), labTensorKey(tensor(i => i % 7 / 7), 40));
  },
  'one pixel off gives another key'() {
    const a = tensor(i => i % 7 / 7), b = tensor(i => i % 7 / 7);
    b[1234] += 1 / 255;
    assert.notEqual(labTensorKey(a, 40), labTensorKey(b, 40));
  },
  'the same numbers laid out at another width are another crop'() {
    const a = tensor(i => i % 5), b = Float32Array.from(a.subarray(0, 3 * 32 * 20));
    assert.notEqual(labTensorKey(a, 40), labTensorKey(b, 20));
    assert.notEqual(labTensorKey(a, 40), labTensorKey(a, 41));
  },
  'a view into a larger buffer is keyed by its own numbers only'() {
    const big = new Float32Array(1000).map((_, i) => i % 11), view = big.subarray(10, 10 + 3 * 32 * 4);
    assert.equal(labTensorKey(view, 4), labTensorKey(Float32Array.from(view), 4));
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n    ', e.message.split('\n')[0]); }
}
console.log(failed ? `${failed} failed` : `all ${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
