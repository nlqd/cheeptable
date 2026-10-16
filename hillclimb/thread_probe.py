import json, subprocess, sys, time
def rodney(*a, timeout=900):
    return subprocess.run(["rodney", *a], capture_output=True, text=True, timeout=timeout).stdout.strip()
threads = sys.argv[1]
rodney("connect", "localhost:9333")
rodney("open", "http://localhost:8081/docs/index.html"); time.sleep(3)
rodney("reload", "--hard"); time.sleep(6)
rodney("js", "(ort.env.wasm.numThreads = %s, 1)" % threads)
rodney("js", "ONNX_MODELS.encoderInt8 = '/hillclimb/models_out/vietocr/encoder_int8.onnx'; 1")
rodney("js", "new Promise(res => { const s = document.createElement('script'); s.src = '/hillclimb/vendor/opencv.js'; s.onload = () => { onOpenCvReady(); res(1); }; document.head.appendChild(s); })")
res = rodney("js", open("speed_probe.js").read())
try:
    d = json.loads(res); print("requested", threads, d["info"])
    print([ (r["tokens"], r["encMs"], r["totalMs"]) for r in d["out"] ])
except ValueError: print(res[:300])
