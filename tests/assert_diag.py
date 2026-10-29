#!/usr/bin/env python3
"""Assertions on the JSON produced by wifidiag.awk from the hostile fixture.

Kept in Python rather than shell: JSON must actually parse, and a shell
grep-based check would happily accept a document that is syntactically broken
but happens to contain the right substrings.
"""

import json
import os
import sys

path = os.environ["OUT"]
with open(path, encoding="utf-8") as fh:
    d = json.load(fh)

errors = []


def check(label, got, want):
    if got != want:
        errors.append(f"{label}: got {got!r}, want {want!r}")


check("summary.total", d["summary"]["total"], 4)
check("summary.n5", d["summary"]["n5"], 3)
check("summary.ndfs", d["summary"]["ndfs"], 1)
check("summary.nunii2c", d["summary"]["nunii2c"], 1)
check("summary.nunii3", d["summary"]["nunii3"], 1)

# The strongest AP has a '|' and an '=' in its name; it must survive verbatim.
check("best.ssid", d["best"]["ssid"], "Coffee | Bar = 7")

# The connected SSID must be the SSID field, not the BSSID field that follows it.
check("link_ssid", d["link_ssid"], "Cafe | Bar=7")
check("link.channel", d["link"]["channel"], 100)
check("link.quality", d["link"]["quality"], "excellent")

# Per-AP identity: this is precisely what a '|'-joined protocol destroys.
by_ch = {a["ch"]: a["ssid"] for a in d["aps"]}
check("ap ch36 ssid", by_ch.get(36), 'it\'s "quoted" \\ back')
check("ap ch149 ssid", by_ch.get(149), "ap fake=1|2")
check("ap ch100 unii", next(a["unii"] for a in d["aps"] if a["ch"] == 100), "UNII-2C")

# The recommended channel must never be a 2.4GHz one while 5GHz is present:
# 2.4GHz has three usable channels shared with every neighbour in range.
best = d["verdict"]["best_ch"]
if best is not None and best < 35:
    errors.append(f"verdict.best_ch: recommended 2.4GHz channel {best}")

# A DFS channel must never be the top pick when clean non-DFS ones exist.
if d["score"] and d["score"][0]["dfs"]:
    errors.append("score[0]: top recommendation is a DFS channel")

check("net.gateway", d["net"]["gateway"], "192.168.1.1")
check("net.loss", d["net"]["loss"], 0)
check("net.rtt_ms", d["net"]["rtt_ms"], 2.4)
check("verdict.net", d["verdict"]["net"], "ok")
check("verdict.dns_l3", d["verdict"]["dns_l3"], "ok")

if errors:
    print("  FAIL")
    for e in errors:
        print("   -", e)
    sys.exit(1)
print("  ok (all assertions passed)")