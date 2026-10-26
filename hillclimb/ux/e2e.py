#!/usr/bin/env python3
"""Run a job through the page and keep what it produced.
  e2e.py URL PDF OUT.json [--port 9333] [--mode guided] [--shots PREFIX] [--lang vi] [--models URL] [--labcache TAG]
Dumps the rows exactly as the engine delivered them (before the results view changes anything) so extraction can be compared
with earlier runs, and optionally takes screenshots during and after the job."""
import json, os, subprocess, sys, tempfile, time

a = sys.argv
url, pdf, out = a[1], a[2], a[3]
opt = lambda k, d=None: a[a.index(k) + 1] if k in a else d
port, mode, shots, lang = opt("--port", "9333"), opt("--mode", "guided"), opt("--shots"), opt("--lang", "vi")
# rodney keeps its connection in $RODNEY_HOME/state.json; lanes on different ports need different homes, or four
# parallel runs drive one browser and write each other's pages.
os.environ.setdefault("RODNEY_HOME", os.path.join(tempfile.gettempdir(), "rodney-" + port))


def rodney(*args, timeout=300):
    r = subprocess.run(["rodney", *args], capture_output=True, text=True, timeout=timeout)
    return (r.stdout + r.stderr).strip()


rodney("connect", "localhost:" + port)
if rodney("js", "1+1") != "2":
    sys.exit("no browser on port %s (check the headless Chrome) — refusing to run against another port" % port)
ready = "typeof CT !== 'undefined' && !!CT.on && !!document.getElementById('fileInput')"


def wait_ready(limit=30):
    t = time.time()
    while time.time() - t < limit:
        if rodney("js", ready) == "true":
            return
        time.sleep(0.2)
    sys.exit("the page did not come up")


models = opt("--models")
# every setting is stated each run (an empty one is removed), so nothing a profile kept from an earlier run still applies
want = {"ct.mode": mode, "ct.lang": lang, "ct.models": models or "", "ct.labcache": opt("--labcache") or ""}
rodney("open", url)
rodney("waitload")
wait_ready()
# the settings live in the browser profile: the page is loaded twice only the first time a lane sees a new setting
have = json.loads(rodney("js", "JSON.stringify(%s.map(k => localStorage.getItem(k) || ''))" % json.dumps(list(want))))
if have != list(want.values()):
    rodney("js", "(%s, 1)" % ", ".join(("localStorage.setItem(%s, %s)" if v else "localStorage.removeItem(%s)") % ((json.dumps(k), json.dumps(v)) if v else (json.dumps(k),)) for k, v in want.items()))
    rodney("open", url)
    rodney("waitload")
    wait_ready()
rodney("js", "(window.alert = () => {}, window.__errors = [], window.addEventListener('error', e => window.__errors.push(String(e.message))), window.addEventListener('unhandledrejection', e => window.__errors.push(String(e.reason))), 1)")
rodney("js", "(CT.on('job:done', d => { window.__rows = d.rows; }), window.__ev = [], window.__reads = [], CT.emit = ((orig) => (t, d) => { window.__ev.push([t, performance.now()]); if (t === 'read') window.__reads.push({text: d.text, conf: d.conf, box: d.box}); return orig(t, d); })(CT.emit), 1)")
t0 = time.time()
rodney("file", "#fileInput", pdf)
shot_at = [3, 12, 25]
state = ""
while time.time() - t0 < 900:
    time.sleep(0.25)
    el = time.time() - t0
    if shots and shot_at and el >= shot_at[0]:
        rodney("screenshot", "%s-%02ds.png" % (shots, shot_at.pop(0)))
    state = rodney("js", "JSON.stringify({done: !!(CT.state && CT.state.done), shown: !document.getElementById('stage-result').hidden, err: window.__errors.slice(0,3)})")
    if '"done":true' in state and '"shown":true' in state:
        break
else:
    sys.exit("timeout: " + state)
elapsed = time.time() - t0
time.sleep(0.3)
if shots:
    rodney("screenshot", shots + "-result.png")
rows = rodney("js", "JSON.stringify(window.__rows)")
open(out, "w").write(rows)
open(out + ".log", "w").write(rodney("js", "(CT.logs || []).map(l => l.msg).join(String.fromCharCode(10))"))   # what the engine said about each page, for diagnosing
if opt("--reads"):                                  # every box the recogniser read, with its confidence: what was seen and what was dropped
    open(opt("--reads"), "w").write(rodney("js", "JSON.stringify(window.__reads)"))
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
