#!/usr/bin/env python3
"""UX metrics harness.   metrics.py LABEL URL [--pdf PATH] [--runs 3] [--port 9333]
Startup (median of runs, cache cleared each time), accessibility (axe-core on the empty page and on the result), and how live the
progress UI is during one job. Writes ux/runs/LABEL.json and prints a summary. Needs a Chrome with remote debugging and rodney."""
import json, os, statistics, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
a = sys.argv
label, url = a[1], a[2]
pdf = a[a.index("--pdf") + 1] if "--pdf" in a else None
runs = int(a[a.index("--runs") + 1]) if "--runs" in a else 3
port = a[a.index("--port") + 1] if "--port" in a else "9333"


def rodney(*args, timeout=300):
    r = subprocess.run(["rodney", *args], capture_output=True, text=True, timeout=timeout)
    return (r.stdout + r.stderr).strip()


def js_file(name):
    return open(os.path.join(HERE, name)).read().strip()


def post(js, timeout=300):
    """Run an async expression in the page and poll for its result (rodney js has a short deadline)."""
    rodney("js", "(window.__r = null, %s.then(v => window.__r = v), 1)" % js)
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(0.5)
        v = rodney("js", "window.__r")
        if v and v != "null":
            return v
    raise SystemExit("timeout waiting for page script")


rodney("connect", "localhost:" + port)
startup = []
for _ in range(runs):
    rodney("clear-cache")
    rodney("open", "about:blank")
    rodney("open", url)
    rodney("waitload")
    time.sleep(1.5)
    startup.append(json.loads(post(js_file("startup.js"))))


def med(key):
    vals = [s[key] for s in startup if s.get(key) is not None]
    return statistics.median(vals) if vals else None


def bytes_before(s, cutoff):
    """Bytes of every resource that started before `cutoff` ms (cross-origin sizes that the browser hides are filled by HEAD)."""
    total = s["htmlBytes"] or 0
    for r in s["resources"]:
        if r["start"] <= cutoff:
            size = r["size"]
            if not size:
                h = subprocess.run(["curl", "--silent", "--location", "--head", "--compressed", r["name"]], capture_output=True, text=True, timeout=30).stdout
                m = [l for l in h.lower().splitlines() if l.startswith("content-length:")]
                size = int(m[-1].split(":")[1]) if m else 0
                r["size"] = size
            total += size
    return total


last = startup[-1]
out = {"label": label, "url": url, "runs": runs,
       "fcp": med("fcp"), "lcp": med("lcp"), "dcl": med("dcl"), "load": med("load"), "cls": med("cls"),
       "longTaskMs": statistics.median([(s["longTasks"] or {}).get("totalMs", 0) for s in startup]),
       "requests": med("requests"), "blockingScripts": med("blockingScripts"), "inlineScriptBytes": med("inlineScriptBytes"),
       "bytesAtLoad": bytes_before(last, last["load"] + 50)}
out["axeEmpty"] = json.loads(post(js_file("axe.js")))

if pdf:
    rodney("open", url)
    rodney("waitload")
    time.sleep(2)
    rodney("js", "(window.alert = () => {}, 1)")
    # job.js is one assignment statement; rodney js accepts only expressions, so pass the right-hand side
    body = js_file("job.js").rstrip(";").split("window.__ux = ", 1)[1]
    rodney("js", "(window.__ux = %s, 1)" % body)
    rodney("js", "(window.__ux.start(), 1)")
    t0 = time.time()
    rodney("file", "#fileInput", pdf)
    done = False
    while time.time() - t0 < 900:
        time.sleep(1)
        if rodney("js", "!!(window.CT && CT.state && CT.state.done) && !document.getElementById('stage-result').hidden && !!document.querySelector('table.grid, .nonehelp')") == "true" \
                or rodney("js", "typeof extractedRows !== 'undefined' && !!document.getElementById('resultPanel') && extractedRows.length > 0 && !document.getElementById('resultPanel').classList.contains('hidden')") == "true":
            done = True
            break
    elapsed = int((time.time() - t0) * 1000)
    out["job"] = json.loads(rodney("js", "window.__ux.report(%d)" % elapsed))
    out["job"]["finished"] = done
    out["axeResult"] = json.loads(post(js_file("axe.js")))

os.makedirs(os.path.join(HERE, "runs"), exist_ok=True)
json.dump(out, open(os.path.join(HERE, "runs", label + ".json"), "w"), indent=1)
print("== %s  %s" % (label, url))
print("FCP %s ms | LCP %s ms | load %s ms | long tasks %s ms | CLS %s" % (out["fcp"], out["lcp"], out["load"], out["longTaskMs"], out["cls"]))
print("requests %s | bytes at load %.2f MB | render-blocking scripts %s | inline JS %d B" % (out["requests"], out["bytesAtLoad"] / 1e6, out["blockingScripts"], out["inlineScriptBytes"]))
print("axe (empty page): %d violations %s" % (len(out["axeEmpty"]), [(v["id"], v["impact"]) for v in out["axeEmpty"]]))
if "job" in out:
    print("job:", out["job"])
    print("axe (result page): %d violations %s" % (len(out["axeResult"]), [(v["id"], v["impact"]) for v in out["axeResult"]]))
