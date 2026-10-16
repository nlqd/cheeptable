#!/usr/bin/env python3
"""Run a job through the page and keep what it produced.
  e2e.py URL PDF OUT.json [--port 9333] [--mode guided] [--shots PREFIX] [--lang vi]
Dumps the rows exactly as the engine delivered them (before the results view changes anything) so extraction can be compared
with earlier runs, and optionally takes screenshots during and after the job."""
import json, subprocess, sys, time

a = sys.argv
url, pdf, out = a[1], a[2], a[3]
opt = lambda k, d=None: a[a.index(k) + 1] if k in a else d
port, mode, shots, lang = opt("--port", "9333"), opt("--mode", "guided"), opt("--shots"), opt("--lang", "vi")


def rodney(*args, timeout=300):
    r = subprocess.run(["rodney", *args], capture_output=True, text=True, timeout=timeout)
    return (r.stdout + r.stderr).strip()


rodney("connect", "localhost:" + port)
rodney("open", "about:blank")
rodney("open", url)
rodney("waitload")
time.sleep(1)
models = opt("--models")
rodney("js", "(localStorage.setItem('ct.mode', '%s'), localStorage.setItem('ct.lang', '%s'), %s 1)" % (mode, lang, ("localStorage.setItem('ct.models', '%s')," % models) if models else ""))
rodney("open", url)
rodney("waitload")
time.sleep(1)
rodney("js", "(window.alert = () => {}, window.__errors = [], window.addEventListener('error', e => window.__errors.push(String(e.message))), window.addEventListener('unhandledrejection', e => window.__errors.push(String(e.reason))), 1)")
rodney("js", "(CT.on('job:done', d => { window.__rows = d.rows; }), window.__ev = [], CT.emit = ((orig) => (t, d) => { window.__ev.push([t, performance.now()]); return orig(t, d); })(CT.emit), 1)")
t0 = time.time()
rodney("file", "#fileInput", pdf)
shot_at = [3, 12, 25]
state = ""
while time.time() - t0 < 900:
    time.sleep(1)
    el = time.time() - t0
    if shots and shot_at and el >= shot_at[0]:
        rodney("screenshot", "%s-%02ds.png" % (shots, shot_at.pop(0)))
    state = rodney("js", "JSON.stringify({done: !!(CT.state && CT.state.done), shown: !document.getElementById('stage-result').hidden, err: window.__errors.slice(0,3)})")
    if '"done":true' in state and '"shown":true' in state:
        break
else:
    sys.exit("timeout: " + state)
elapsed = time.time() - t0
time.sleep(1.5)
if shots:
    rodney("screenshot", shots + "-result.png")
rows = rodney("js", "JSON.stringify(window.__rows)")
open(out, "w").write(rows)
ev = json.loads(rodney("js", "JSON.stringify(window.__ev)"))
if ev:
    t0 = next((t for n, t in ev if n == 'job:begin'), ev[0][1])
    first = lambda name: next((round(t - t0) for n, t in ev if n == name), None)
    last = lambda name: max((round(t - t0) for n, t in ev if n == name), default=None)
    print("timeline ms after the file was chosen: engine loaded %s | models ready %s | first page image %s | first read %s | last read %s | build %s | done %s" % (
        first('job:start'), first('models:ready'), first('page:render'), first('read'), last('read'), first('build:start'), first('job:done')))
    stamps = sorted(t for n, t in ev if n not in ('lang', 'mode', 'stage'))
    gaps = sorted(((b - a, a) for a, b in zip(stamps, stamps[1:])), reverse=True)[:4]
    names = lambda at: [n for n, t in ev if abs(t - at) < 1][:1]
    print("longest silences between engine events (ms): %s" % [(round(g), names(at)[0] if names(at) else '?', round(at - t0)) for g, at in gaps])
info = rodney("js", "JSON.stringify({rendered: document.querySelectorAll('table.grid tbody tr').length, title: document.getElementById('resTitle') && document.getElementById('resTitle').textContent, counter: document.querySelector('.rcount') && document.querySelector('.rcount').textContent, errors: window.__errors})")
print("done in %.0f s | %s" % (elapsed, info))
