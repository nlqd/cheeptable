#!/usr/bin/env python3
"""axe-core on the start page and on a result, in every layout and language, plus a simulated dark theme.
  axe_modes.py URL PDF [--port 9333]"""
import json, subprocess, sys, time

a = sys.argv
url, pdf = a[1], a[2]
port = a[a.index("--port") + 1] if "--port" in a else "9333"
HERE = __file__.rsplit("/", 1)[0]
AXE = open(HERE + "/axe.js").read().strip()
DARK = {"--bg": "#0b1220", "--surface": "#162033", "--border": "#334155", "--text": "#e2e8f0", "--dim": "#a8b3c4", "--accent": "#60a5fa",
        "--on-accent": "#0b1220", "--ok": "#34d399", "--warn-bg": "#422006", "--warn": "#fcd34d", "--err": "#fca5a5", "--focus": "#93c5fd"}


def rodney(*args, timeout=300):
    r = subprocess.run(["rodney", *args], capture_output=True, text=True, timeout=timeout)
    return (r.stdout + r.stderr).strip()


def post(js):
    rodney("js", "(window.__r = null, %s.then(v => window.__r = v), 1)" % js)
    for _ in range(120):
        time.sleep(0.5)
        v = rodney("js", "window.__r")
        if v and v != "null":
            return json.loads(v)


def load(mode, lang):
    rodney("open", "about:blank"); rodney("open", url); rodney("waitload")
    models = __import__("os").environ.get("CT_MODELS")      # a copy of the models to test instead of the hosted ones
    rodney("js", "(localStorage.setItem('ct.mode', '%s'), localStorage.setItem('ct.lang', '%s'), %s 1)" % (mode, lang, ("localStorage.setItem('ct.models', '%s')," % models) if models else ""))
    rodney("open", url); rodney("waitload"); time.sleep(0.8)


def show(label, v):
    print("%-34s %s" % (label, "0 violations" if not v else "%d: %s" % (len(v), [(x["id"], x["impact"], x["nodes"]) for x in v])))


rodney("connect", "localhost:" + port)
bad = 0
for mode in ("simple", "guided", "workbench"):
    for lang in ("vi", "en"):
        load(mode, lang)
        v1 = post(AXE)
        rodney("js", "(window.alert = () => {}, 1)")
        rodney("file", "#fileInput", pdf)
        for _ in range(120):
            time.sleep(1)
            if rodney("js", "!!(CT.state && CT.state.done) && !document.getElementById('stage-result').hidden && !!document.querySelector('table.grid')") == "true":
                break
        time.sleep(1)
        v2 = post(AXE)
        show("%s/%s start" % (mode, lang), v1); show("%s/%s result" % (mode, lang), v2)
        bad += len(v1) + len(v2)
        if mode == "guided" and lang == "vi":
            sets = ",".join("document.documentElement.style.setProperty('%s','%s')" % kv for kv in DARK.items())
            rodney("js", "(%s, document.documentElement.style.colorScheme='dark', 1)" % sets)
            v3 = post(AXE)
            show("guided/vi result, dark colours", v3)
            bad += len(v3)
print("total violations:", bad)
