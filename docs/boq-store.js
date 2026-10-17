// boq-store.js — where the model files live on the visitor's device. Used by the page and by the OCR workers.
//  - finished files: Cache API first, IndexedDB if the Cache API refuses (some mobile browsers and private modes do)
//  - partial downloads: IndexedDB, so a tab that is killed mid-download (common on phones) resumes instead of starting over
//  - persistence: asks the browser not to evict the models when it is short of space
'use strict';

const CTStore = (() => {
  const CACHE = 'boq-onnx-models-v1';
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((ok, fail) => {
    if (typeof indexedDB === 'undefined') return fail(new Error('no IndexedDB'));
    const r = indexedDB.open('ct-models', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('blobs'); r.result.createObjectStore('parts'); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  }));
  const run = (store, mode, fn) => db().then(d => new Promise((ok, fail) => {
    const t = d.transaction(store, mode);
    let req;
    try { req = fn(t.objectStore(store)); } catch (e) { return fail(e); }
    t.oncomplete = () => ok(req && 'result' in req ? req.result : undefined);
    t.onerror = t.onabort = () => fail(t.error);
  }));
  const pad = (i) => String(i).padStart(5, '0');

  return {
    async has(url) {
      try { const c = await caches.open(CACHE); if (await c.match(url)) return 'cache'; } catch (e) { /* fall through */ }
      try { if (await run('blobs', 'readonly', s => s.count(url))) return 'idb'; } catch (e) { /* none */ }
      return null;
    },
    async get(url) {
      try { const c = await caches.open(CACHE); const hit = await c.match(url); if (hit) return hit; } catch (e) { /* fall through */ }
      try {
        const rec = await run('blobs', 'readonly', s => s.get(url));
        if (rec) return new Response(rec.blob, { status: 200, headers: { 'Content-Type': rec.type || 'application/octet-stream' } });
      } catch (e) { /* none */ }
      return null;
    },
    // Returns where the file was kept: 'cache', 'idb' or null (kept nowhere: it will be downloaded again next time).
    async put(url, blob, type) {
      try {
        const c = await caches.open(CACHE);
        await c.put(url, new Response(blob, { status: 200, headers: { 'Content-Type': type || 'application/octet-stream' } }));
        return 'cache';
      } catch (e) { /* try IndexedDB */ }
      try { await run('blobs', 'readwrite', s => s.put({ blob, type }, url)); return 'idb'; } catch (e) { return null; }
    },
    async remove(url) {
      try { await (await caches.open(CACHE)).delete(url); } catch (e) { /* none */ }
      try { await run('blobs', 'readwrite', s => s.delete(url)); } catch (e) { /* none */ }
    },
    async loadParts(url) {
      try {
        const range = IDBKeyRange.bound(url + '|0', url + '|9￿');
        const parts = await run('parts', 'readonly', s => s.getAll(range));
        const meta = await run('parts', 'readonly', s => s.get(url + '|meta'));
        const chunks = (parts || []).map(p => new Uint8Array(p));
        return { chunks, loaded: chunks.reduce((n, c) => n + c.length, 0), total: meta ? meta.total : 0 };
      } catch (e) { return null; }
    },
    savePart(url, index, bytes) { return run('parts', 'readwrite', s => s.put(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), url + '|' + pad(index))).catch(() => {}); },
    saveMeta(url, meta) { return run('parts', 'readwrite', s => s.put(meta, url + '|meta')).catch(() => {}); },
    clearParts(url) { return run('parts', 'readwrite', s => s.delete(IDBKeyRange.bound(url + '|', url + '|￿'))).catch(() => {}); },
    // Whether the recogniser is on the device, without knowing its host: the page asks this before the engine is loaded.
    async cachedKinds() {
      const urls = [];
      try { urls.push(...(await (await caches.open(CACHE)).keys()).map(r => r.url)); } catch (e) { /* none */ }
      try { urls.push(...(await run('blobs', 'readonly', s => s.getAllKeys())) || []); } catch (e) { /* none */ }
      return { model: urls.some(u => /vietocr\/cheep-[^/]*\/model\.bin/.test(u)) };
    },
    async persist() { try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch (e) { return false; } },
    async persisted() { try { return navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) { return false; } },
    async estimate() { try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (e) { return null; } },
  };
})();
