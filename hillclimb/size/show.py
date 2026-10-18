import json, sys
t = {"all": 0.0301, "all3": 0.9619}
print("%-8s %6s %6s %6s %7s %6s %6s %6s %6s %7s" % ("run", "cer", "dev", "test", "all3", "clean", "rough", "agree", "MB", "bench2"))
for n in sys.argv[1:]:
    r = json.load(open(f"runs/{n}.json"))
    print("%-8s %6.4f %6.4f %6.4f %7.4f %6.4f %6.4f %6.4f %6.2f %7s  params %.1fM" % (n, r["all"]["cer"], r["dev"]["cer"], r["test"]["cer"], r["all"]["all3"], r["bench"]["clean"], r["bench"]["rough"], r["agree_err"], r["size_mb"], r.get("bench2", {}).get("all", "-"), r["params_m"]))
