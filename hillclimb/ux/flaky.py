#!/usr/bin/env python3
"""Does the page recover from a bad network?  flaky.py URL FIXTURE_PDF [--port 9333]  (serve.py on :8080 must be running)
Part 1: the first two requests for each model file are cut after 3 MB. The job must finish by itself, resuming the partial downloads.
Part 2: every request is cut after 1 MB. The job must fail with a Try again button; after the network heals, that button must work."""
import json, subprocess, sys, time, urllib.request

a = sys.argv
url, pdf = a[1], a[2]
port = a[a.index("--port") + 1] if "--port" in a else "9333"
BASE = "http://localhost:8080"
HOSTED = "/home/dungngo/experiments/vietocr/hillclimb/size/hosted/vietocr/cheep-v1/"
FILES = ["model.bin", "enc.skel.onnx", "encq.skel.onnx", "init.skel.onnx", "step.skel.onnx"]    # the files a CPU visit fetches


def rodney(*args, timeout=300):
    r = subprocess.run(["rodney", *args], capture_output=True, text=True, timeout=timeout)
    return (r.stdout + r.stderr).strip()


def js(expr):
    return rodney("js", expr)


def ctl(**kw):
    q = "&".join("%s=%s" % kv for kv in kw.items())
    return json.load(urllib.request.urlopen(BASE + "/ctl?" + q))


def fresh(keep_cache=False):
    rodney("open", "about:blank"); rodney("open", url); rodney("waitload")
    if not keep_cache:
        js("(caches.keys().then(k => Promise.all(k.map(n => caches.delete(n)))), 1)"); time.sleep(0.5)
    js("(localStorage.removeItem('ct.models'), 1)")         # the pinned-hash check is skipped for a developer's own copy
    rodney("open", url); rodney("waitload"); time.sleep(0.8)
    js("(window.alert = () => {}, window.__retries = 0, CT.on('model:retry', () => window.__retries++), 1)")
    # the engine loads on demand, so its settings exist only after it has loaded; then point the CPU-path models at the flaky route
    js("(window.__ready = false, CT.preloadEngine().then(() => { ONNX_MODELS.compact = '%s/flaky/hillclimb/size/hosted/vietocr/cheep-v1'; window.__ready = true; }), 1)" % BASE)
    for _ in range(60):
        if js("window.__ready") == "true":
            break
        time.sleep(0.5)


def wait(expr, seconds):
    t0 = time.time()
    while time.time() - t0 < seconds:
        if js(expr) == "true":
            return True
        time.sleep(0.7)
    return False


rodney("connect", "localhost:" + port)
sizes = {f: len(open(HOSTED + f, "rb").read()) for f in FILES}
total = sum(sizes.values())
ok_all = []

print("Part 1: the first two requests per file stop after 3 MB")
ctl(reset=1, cut=3000000, times=2)
fresh()
rodney("file", "#fileInput", pdf)
done = wait("!!(CT.state && CT.state.done) && !document.getElementById('stage-result').hidden", 180)
stats = ctl()
sent = sum(stats["sent"].values())
retries = js("window.__retries")
print("  finished by itself: %s | retry events: %s | bytes served %.1f MB for %.1f MB of models (%.0f%% overhead)" % (done, retries, sent / 1e6, total / 1e6, 100 * (sent - total) / total))
ok_all += [done, int(retries or 0) >= 2, sent < total * 1.35]

print("Part 2: the network is down (every request stops after 1 MB)")
ctl(reset=1, cut=1000000, times=999)
fresh()
rodney("file", "#fileInput", pdf)
failed = wait("!!document.querySelector('.endmsg button') && !document.querySelector('.endmsg').hidden && document.body.dataset.stage === 'progress'", 150)
msg = js("document.querySelector('.endmsg p') && document.querySelector('.endmsg p').textContent")
labels = js("JSON.stringify([...document.querySelectorAll('.endmsg button')].map(b => b.textContent))")
print("  job failed with a message and buttons: %s | %s | %s" % (failed, labels, msg[:90]))
ok_all += [failed, "Thử lại" in labels]
ctl(reset=1, times=0)
rodney("click", ".endmsg .btn:not(.quiet)")
done = wait("!!(CT.state && CT.state.done) && !document.getElementById('stage-result').hidden", 180)
stats = ctl()
print("  after the network healed, Try again finished the job: %s | bytes served in the second run %.1f MB" % (done, sum(stats["sent"].values()) / 1e6))
ok_all.append(done)
print("Part 3: the tab is killed after about 4 MB of a slow download, then the page is opened again")
ctl(reset=1, cut=0, times=0, slow=60)
fresh()
js("(window.__got = 0, CT.on('model:progress', e => { if (!e.cached) window.__got = Math.max(window.__got, e.loaded); }), window.__sum = {}, CT.on('model:progress', e => { window.__sum[e.url] = e.loaded; }), 1)")
rodney("file", "#fileInput", pdf)
wait("Object.values(window.__sum).reduce((a, b) => a + b, 0) > 4000000", 60)
saved_mb = js("Object.values(window.__sum).reduce((a, b) => a + b, 0) / 1e6")
rodney("open", "about:blank")                       # the page is gone, as if the browser had killed it
ctl(reset=1, slow=0)
fresh()
rodney("file", "#fileInput", pdf)
done = wait("!!(CT.state && CT.state.done) && !document.getElementById('stage-result').hidden", 180)
sent = sum(ctl()["sent"].values())
print("  downloaded %.1f MB before the kill; after reopening the job finished: %s, and the server sent %.1f MB of %.1f MB (the rest came from what was saved)" % (float(saved_mb), done, sent / 1e6, total / 1e6))
ok_all += [done, sent < total * 0.85]
print("Part 4: a damaged copy of the model in the browser cache is replaced")
ctl(reset=1, cut=0, times=0, slow=0)
fresh()
rodney("file", "#fileInput", pdf)
wait("!!(CT.state && CT.state.done) && !document.getElementById('stage-result').hidden", 180)
js("(caches.open('boq-onnx-models-v1').then(c => c.keys().then(ks => Promise.all(ks.filter(r => /model\\.bin$/.test(r.url)).map(r => c.put(r, new Response(new Uint8Array(4000000))))))), 1)"); time.sleep(1)
ctl(reset=1)
fresh(keep_cache=True)
rodney("file", "#fileInput", pdf)
done = wait("!!(CT.state && CT.state.done) && !document.getElementById('stage-result').hidden", 180)
sent = ctl()["sent"]
mb = sum(v for k, v in sent.items() if k.endswith("model.bin")) / 1e6
print("  job finished with the damaged copy in the cache: %s | model.bin fetched again: %.1f MB (the other four files came from the cache)" % (done, mb))
ok_all += [done, mb > 8, sum(v for k, v in sent.items() if not k.endswith("model.bin")) < 1]
print("%d of %d checks passed" % (sum(bool(x) for x in ok_all), len(ok_all)))
