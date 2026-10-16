import json, sys, time
sys.path.insert(0, ".")
import evalkit as E
t = time.time()
m, v = E.load_teacher()
res, _ = E.evaluate(m, v, "teacher")
print(json.dumps(res), round(time.time() - t), "s on", E.DEV)
