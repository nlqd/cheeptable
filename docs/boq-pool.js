// boq-pool.js — a small pool of OCR workers (see boq-worker.js). recognize() queues one crop and resolves with its text.
'use strict';

class OcrPool {
  constructor(workers) {
    this.idle = workers;
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    workers.forEach(w => {
      w.onmessage = ({ data }) => this._done(w, data);
      w.onerror = (e) => this._fail(w, e.message || 'worker error');
    });
  }

  // init: { wasmPaths, cacheName, encoderUrl, decoderUrl, vocab }. Rejects if any worker cannot start.
  static async create(count, init) {
    const workers = Array.from({ length: count }, () => new Worker('boq-worker.js'));
    await Promise.all(workers.map(w => new Promise((resolve, reject) => {
      w.onmessage = ({ data }) => (data.type === 'ready' ? resolve() : reject(new Error(data.message || 'worker init failed')));
      w.onerror = (e) => reject(new Error(e.message || 'worker failed to load'));
      w.postMessage({ type: 'init', ...init });
    }))).catch(e => { workers.forEach(w => w.terminate()); throw e; });
    return new OcrPool(workers);
  }

  recognize(tensor) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.queue.push({ id, data: tensor.data, dims: tensor.dims, resolve, reject });
      this._dispatch();
    });
  }

  _dispatch() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const job = this.queue.shift();
      this.pending.set(job.id, { job, worker: w });
      w.postMessage({ type: 'read', id: job.id, data: job.data, dims: job.dims }, [job.data.buffer]);
    }
  }

  _done(worker, msg) {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    this.idle.push(worker);
    if (msg.type === 'result') entry.job.resolve({ text: msg.text, confidence: msg.confidence });
    else entry.job.reject(new Error(msg.message));
    this._dispatch();
  }

  _fail(worker, message) {
    for (const [id, entry] of this.pending) {
      if (entry.worker === worker) { this.pending.delete(id); entry.job.reject(new Error(message)); }
    }
  }

  get size() { return this.idle.length + this.pending.size; }

  close() { [...this.idle, ...[...this.pending.values()].map(e => e.worker)].forEach(w => w.terminate()); }
}
