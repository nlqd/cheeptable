#!/usr/bin/env python3
"""Functional checks of the page.  functional.py URL FIXTURE_DIR [--port 9333]   Prints PASS / FAIL lines."""
import json, subprocess, sys, time

a = sys.argv
url, fx = a[1], a[2]
port = a[a.index("--port") + 1] if "--port" in a else "9333"


def rodney(*args, timeout=300):
    r = subprocess.run(["rodney", *args], capture_output=True, text=True, timeout=timeout)
    return (r.stdout + r.stderr).strip()


def js(expr):
    return rodney("js", expr)


def fresh(mode="guided", lang="vi"):
    rodney("open", "about:blank"); rodney("open", url); rodney("waitload")
    js("(localStorage.setItem('ct.mode', '%s'), localStorage.setItem('ct.lang', '%s'), 1)" % (mode, lang))
    rodney("open", url); rodney("waitload"); time.sleep(0.8)
    js("(window.alert = () => { window.__alerted = true; }, window.__errors = [], window.addEventListener('error', e => window.__errors.push(String(e.message))), window.addEventListener('unhandledrejection', e => window.__errors.push(String(e.reason))), 1)")


def wait(expr, seconds=240):
    t0 = time.time()
    while time.time() - t0 < seconds:
        if js(expr) == "true":
            return True
        time.sleep(0.7)
    return False


results = []
def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (("  " + detail) if detail and not ok else ""))


RESULT_READY = "!!(CT.state && CT.state.done) && !document.getElementById('stage-result').hidden && !!document.querySelector('table.grid, .nonehelp')"
rodney("connect", "localhost:" + port)

# 1. a file of the wrong type: an inline message, no alert, no job
fresh()
rodney("file", "#fileInput", fx + "/notes.txt"); time.sleep(0.8)
check("wrong file type gives an inline error", js("document.getElementById('notice').dataset.kind === 'error' && !document.getElementById('notice').hidden") == "true")
check("  and stays on the start screen, without alert()", js("document.body.dataset.stage === 'start' && !window.__alerted") == "true")

# 2. cancel in the middle of a job, then run another job on the same page
fresh()
rodney("file", "#fileInput", fx + "/p345.pdf")
started = wait("typeof _pool !== 'undefined' && _pool !== null", 120)
rodney("click", "#cancelBtn"); time.sleep(1.5)
check("cancel mid-job stops the workers", started and js("_pool === null") == "true")
check("  shows a cancelled message and a way back", js("document.querySelector('.endmsg') && !document.querySelector('.endmsg').hidden && document.querySelector('.endmsg button') !== null") == "true")
rodney("click", ".endmsg button"); time.sleep(0.5)
check("  returns to the start screen", js("document.body.dataset.stage === 'start'") == "true")
rodney("file", "#fileInput", fx + "/page3.pdf")
ok = wait(RESULT_READY)
check("a job after a cancel completes", ok and int(js("document.querySelectorAll('table.grid tbody tr:not([hidden])').length") or 0) > 5)

# 3. keyboard: jump to the first cell to check, edit it, confirm; the counter must go down
before = js("document.querySelector('.rcount').textContent")
js("(document.querySelector('tr:not([hidden]) td').focus(), 1)")
rodney("key", "]"); time.sleep(0.4)
cell = js("document.activeElement.className + '|' + document.activeElement.dataset.r + ',' + document.activeElement.dataset.c")
check("']' jumps to a cell that needs checking", 'flag-check' in cell, cell)
rodney("key", "Enter"); time.sleep(0.3)
check("Enter opens an editor", js("document.activeElement.tagName === 'INPUT'") == "true")
rodney("key", "Enter"); time.sleep(0.5)
after = js("document.querySelector('.rcount').textContent")
check("confirming a cell lowers the counter", before != after, before + " -> " + after)

# 4. the Excel file: sheet names, header, numbers as numbers
js("(window.__x = null, 1)")
wait("typeof XLSX !== 'undefined'", 60)
js("(XLSX.writeFile = (wb, name) => { window.__x = { name, sheets: wb.SheetNames, a1: wb.Sheets[wb.SheetNames[0]]['A1'] && wb.Sheets[wb.SheetNames[0]]['A1'].v, d3: wb.Sheets[wb.SheetNames[0]]['D3'] && typeof wb.Sheets[wb.SheetNames[0]]['D3'].v }; }, 1)")
rodney("click", "#dlXlsx"); time.sleep(1.5)
x = js("JSON.stringify(window.__x)")
check("Excel export is named after the file and has the table sheet", '"name":"page3.xlsx"' in x and "Bảng đã đọc" in x, x)
check("  numbers are written as numbers", '"d3":"number"' in x, x)

# 5. language switch re-renders the results in English
js("(CT.setLang('en'), 1)"); time.sleep(0.8)
check("English: title and button are translated", "Read" in js("document.getElementById('resTitle').textContent") and "Download" in js("document.getElementById('dlXlsx').textContent"))
js("(CT.setLang('vi'), 1)")

# 6. an image instead of a PDF
fresh()
rodney("file", "#fileInput", fx + "/page3img-03.png")
ok = wait(RESULT_READY)
rows = int(js("document.querySelectorAll('table.grid tbody tr:not([hidden])').length") or 0) if ok else 0
check("a PNG image is read as a one-page table", ok and rows > 5, "rows shown: %s" % rows)

# 7. a page with no table
fresh()
rodney("file", "#fileInput", fx + "/prose.pdf")
ok = wait(RESULT_READY, 200)
none = js("!!document.querySelector('.nonehelp')") == "true"
dis = js("!!document.getElementById('dlXlsx') && document.getElementById('dlXlsx').disabled") == "true"
print("INFO a prose page: finished=%s, shows 'no table' state=%s, download disabled=%s, rows shown=%s" % (ok, none, dis, js("document.querySelectorAll('table.grid tbody tr:not([hidden])').length")))


# 8. paste and drop anywhere on the page start a job
fresh()
js("(fetch('sample.pdf').then(r => r.blob()).then(b => { const dt = new DataTransfer(); dt.items.add(new File([b], 'pasted.pdf', {type: 'application/pdf'})); document.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})); }), 1)")
check("pasting a file starts a job", wait("document.body.dataset.stage === 'progress' || document.body.dataset.stage === 'result'", 20))
fresh()
js("(fetch('sample.pdf').then(r => r.blob()).then(b => { const dt = new DataTransfer(); dt.items.add(new File([b], 'dropped.pdf', {type: 'application/pdf'})); document.body.dispatchEvent(new DragEvent('dragenter', {dataTransfer: dt, bubbles: true})); document.body.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true})); }), 1)")
check("dropping a file anywhere on the page starts a job", wait("document.body.dataset.stage === 'progress' || document.body.dataset.stage === 'result'", 20))

# 9. low-memory mode: one worker; a killed tab turns it on by itself
fresh()
js("(localStorage.setItem('ct.lowmem', '1'), 1)")
rodney("open", url); rodney("waitload"); time.sleep(0.8)
check("the low-memory switch shows its stored state", js("document.getElementById('lowmem').checked") == "true")
js("(window.alert = () => {}, 1)")
rodney("file", "#fileInput", fx + "/p345.pdf")
started = wait("typeof _pool !== 'undefined' && _pool !== null", 120)
workers = js("_pool ? _pool.size : 0")
check("low-memory mode uses one worker", started and workers == "1", "workers: %s" % workers)
rodney("click", "#cancelBtn"); time.sleep(1)
js("(CT.pref.set = () => {}, localStorage.setItem('ct.lowmem', ''), localStorage.setItem('ct.running', String(Date.now())), 1)")   # a real kill leaves the flag behind; closing the page normally clears it
rodney("open", url); rodney("waitload"); time.sleep(0.8)
check("a tab killed mid-job is noticed on the next visit", "đóng đột ngột" in js("document.getElementById('notice').textContent") and js("localStorage.getItem('ct.lowmem')") == "1")
js("(localStorage.setItem('ct.lowmem', ''), 1)")

# 10. after a job the models are on the device, and the start page says so
fresh()
rodney("file", "#fileInput", fx + "/page3.pdf")
wait(RESULT_READY, 200)
no_errors = js("window.__errors.length === 0") == "true"; err_detail = js("JSON.stringify(window.__errors)")
rodney("open", url); rodney("waitload"); time.sleep(1.5)
note = js("document.getElementById('modelNote').textContent")
check("the start page says the models are already on the device", "đã có sẵn" in note, note[:80])

check("no uncaught page errors in the last full job", no_errors, err_detail)
print("%d of %d checks passed" % (sum(results), len(results)))
