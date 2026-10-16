// Startup metrics of the page that is currently loaded. Returns JSON. Run after the load event plus a short settle.
(async () => {
  const nav = performance.getEntriesByType('navigation')[0];
  const paint = Object.fromEntries(performance.getEntriesByType('paint').map(p => [p.name, Math.round(p.startTime)]));
  const observe = (type) => new Promise(res => {
    const out = [];
    try { new PerformanceObserver(l => out.push(...l.getEntries())).observe({ type, buffered: true }); } catch (e) { return res(null); }
    setTimeout(() => res(out), 300);
  });
  const [lcp, shifts, longs] = await Promise.all([observe('largest-contentful-paint'), observe('layout-shift'), observe('longtask')]);
  const loadEnd = nav.loadEventEnd;
  const res = performance.getEntriesByType('resource').map(e => ({ name: e.name, start: Math.round(e.startTime), size: e.transferSize || e.encodedBodySize || 0, type: e.initiatorType }));
  const scripts = [...document.scripts];
  return JSON.stringify({
    dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(loadEnd),
    fcp: paint['first-contentful-paint'] || null,
    lcp: lcp && lcp.length ? Math.round(lcp[lcp.length - 1].startTime) : null,
    cls: shifts ? +shifts.filter(s => !s.hadRecentInput).reduce((a, s) => a + s.value, 0).toFixed(4) : null,
    longTasks: longs ? { count: longs.length, totalMs: Math.round(longs.reduce((a, t) => a + t.duration, 0)) } : null,
    requests: res.length + 1, htmlBytes: nav.transferSize || nav.encodedBodySize,
    blockingScripts: scripts.filter(s => s.src && !s.async && !s.defer && s.type !== 'module').length,
    inlineScriptBytes: scripts.filter(s => !s.src).reduce((a, s) => a + s.text.length, 0),
    resources: res,
  });
})()
