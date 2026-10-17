// Instrument the visible progress UI, then report how live it was. window.__ux.start() before the upload, window.__ux.report() after.
window.__ux = (() => {
  let t0 = 0, stamps = [], obs = [];
  const targets = () => document.querySelectorAll('#progressPanel, [data-progress]');
  return {
    start() {
      t0 = performance.now(); stamps = [];
      obs.forEach(o => o.disconnect());
      const watch = () => targets().forEach(el => {
        if (el.__uxWatched) return; el.__uxWatched = true;
        // what a person can see change: text, new nodes, and the style/class/hidden of the bars and thumbnails (not the screen-reader copy)
        const o = new MutationObserver((list) => { if (list.some(m => !(m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest('.sr'))) stamps.push(performance.now() - t0); });
        o.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
        obs.push(o);
      });
      watch(); this.timer = setInterval(watch, 200);   // panels may be created after the start
    },
    report(endMs) {
      clearInterval(this.timer);
      const end = endMs ?? (performance.now() - t0);
      const s = stamps.filter(x => x <= end).sort((a, b) => a - b);
      const gaps = s.slice(1).map((x, i) => x - s[i]);
      const windows = Math.floor(end / 250), hit = new Set(s.map(x => Math.floor(x / 250)));
      return JSON.stringify({
        jobMs: Math.round(end), updates: s.length, firstUpdateMs: s.length ? Math.round(s[0]) : null,
        maxGapMs: Math.round(Math.max(0, ...gaps, s.length ? end - s[s.length - 1] : end)),
        windowsWithUpdate: windows ? +(hit.size / windows).toFixed(2) : null,
        updatesPerSec: +(s.length / (end / 1000)).toFixed(1),
      });
    },
  };
})();
