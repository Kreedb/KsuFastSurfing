# Emits the whole diagnosis as one JSON document.
#
# Why one awk pass instead of assembling key=value in shell and converting:
# the scan cache is whitespace aligned and an SSID may contain '|', '=', '"',
# '\\' or anything else the AP felt like naming itself. A shell protocol that
# joins fields with '|' then splits on '|' silently reshuffles columns for such
# SSIDs (a real one named "ap fake=1|2" turned into freq=2, ch=5745, rssi=149).
# Producing JSON from the same awk that parses the columns means no intermediate
# text encoding exists to be broken.
#
# Invoked as:  awk -f jsonlib.awk -f wifidiag.awk scan.txt link.txt net.txt
# Files are distinguished by basename; a missing file is simply skipped.

function base(p,   a, n) { n = split(p, a, "/"); return a[n] }

function chan_of(f) {
  if (f <= 2500) return (f == 2484) ? 14 : int((f - 2407) / 5)
  if (f <= 5895) return int((f - 5000) / 5)
  return int((f - 5950) / 5)
}

function is_dfs(c) { return ((c >= 52 && c <= 64) || (c >= 100 && c <= 144)) ? 1 : 0 }

function band_of(f) {
  if (f <= 2500) return "2.4"
  if (f <= 5895) return "5"
  return "6"
}

# UNII sub-band by channel number, never by frequency: 5725 MHz is exactly
# ch149, so a frequency test would label the first UNII-3 channel as UNII-2C.
function unii_of(c) {
  if (c < 36)              return "-"
  if (c <= 64)             return "UNII-2A"
  if (c <= 144)            return "UNII-2C"
  return "UNII-3"
}

# Linear power ranking unit. busybox awk has no math support at all
# ("Math support is not compiled in"), so 10^(r/10) would abort on device.
# 1 unit = power of -100 dBm; one step = 0.5 dB = 1.122x.
function pw(r,   v, k) {
  k = int((r + 100) * 2)
  if (k < 0) return 0
  if (k > 440) k = 440
  v = 1
  while (k-- > 0) v *= 1.122
  return v
}

function quality(r) {
  if (r >= -50) return "excellent"
  if (r >= -60) return "good"
  if (r >= -70) return "fair"
  return "weak"
}

BEGIN {
  schema = 1; na = 0; ndfsch = 0
  # Two renderers share one computation pass. Default to the text report so the
  # old `report` behaviour is preserved; the shell passes -v out_fmt=json for
  # the machine interface.
  if (out_fmt == "") out_fmt = "text"
}

{
  f = base(FILENAME)

  if (f == "scan.txt") {
    if (FNR == 1) next                     # header row
    freq = $2 + 0
    if (freq < 2400) next
    if (NF < 5) next

    r3 = $3; sub(/\(.*/, "", r3); rssi = int(r3)
    age = int($4)

    # SSID runs from field 5 up to the first bracketed Flags column.
    ssid = ""
    i = 5
    for (; i <= NF; i++) { if ($i ~ /^\[/) break; ssid = (ssid == "" ? $i : ssid " " $i) }
    if (ssid == "null") ssid = ""
    flags = ""
    for (; i <= NF; i++) flags = flags $i

    ch = chan_of(freq)
    band = band_of(freq)
    dfs = is_dfs(ch)

    n++
    if (band == "2.4") n24++
    else if (band == "5") { n5++; if (dfs) ndfs++ } else n6++

    u = unii_of(ch)
    if (u == "UNII-2A") nu2a++
    if (u == "UNII-2C") nu2c++
    if (u == "UNII-3")  nu3++
    if (flags ~ /SAE/) nw3++
    if (flags !~ /RSN|WPA/) nopen++

    if (dfs && !(ch in dfs_seen)) { dfs_seen[ch] = 1; dfs_ch[++ndfsch] = ch }

    # One row per SSID (strongest BSSID wins) for the AP table, but a separate
    # BSSID-level count for congestion: several radios on one channel is the
    # whole point of that metric.
    cong[ch]++
    cnt[ch] = 1

    # Interference load is accumulated from every raw BSS row, not from the
    # de-duplicated AP table: five BSSIDs of one SSID still occupy the channel
    # five times, and the dedup would have counted them once.
    p = pw(rssi)
    co_n[ch]++
    ld[ch] += p
    for (d = -4; d <= 4; d++) {
      if (d == 0) continue
      k = ch + d
      if (k < 1) continue
      adj_n[k]++
      ld[k] += p / 4
    }
    if (!(ssid in best_rssi) || rssi > best_rssi[ssid]) {
      best_rssi[ssid] = rssi
      if (ssid != "" && !(ssid in listed)) {
        listed[ssid] = 1
        na++
        a_ssid[na] = ssid; a_freq[na] = freq; a_ch[na] = ch
        a_rssi[na] = rssi; a_age[na] = age; a_dfs[na] = dfs
        a_band[na] = band; a_unii[na] = u
      } else {
        # already listed, upgrade its RSSI in place
        for (j = 1; j <= na; j++) if (a_ssid[j] == ssid) a_rssi[j] = rssi
      }
    }

    if (n == 1 || rssi > best) { best = rssi; best_ssid = ssid; best_freq = freq }
    if (age > age_max) age_max = age

    # Multi-BSSID detection uses the raw BSSID so a mesh shows up even when the
    # node names differ.
    bssid = $1
    if (!(bssid in bss_seen)) { bss_seen[bssid] = 1; bss_cnt[ssid]++ }

    next
  }

  if (f == "link.txt") {
    # WifiInfo, one line, comma separated: SSID: "x", ..., RSSI: -51, ...
    if ($0 !~ /WifiInfo:/ && $0 !~ /SSID:/) next
    nf = split($0, kv, ",")
    for (i = 1; i <= nf; i++) {
      t = kv[i]
      if (t ~ /Frequency:/)   { sub(/.*Frequency:[ \t]*/, "", t); sub(/[^0-9].*/, "", t); l_freq = t + 0 }
      if (t ~ /Link speed:/)  { sub(/.*Link speed:[ \t]*/, "", t); sub(/[^0-9].*/, "", t); l_mbps = t + 0 }
      if (t ~ /RSSI:/)        { sub(/.*RSSI:[ \t]*/, "", t); sub(/[^0-9-].*/, "", t); l_rssi = t + 0 }
      if (t ~ /Wi-Fi standard:/) { sub(/.*Wi-Fi standard:[ \t]*/, "", t); sub(/[^0-9a-z].*/, "", t); l_std = t }
      # Match "SSID:" as a whole field. Testing t ~ /SSID:/ also hits "BSSID:",
      # which is why the connected SSID came out as " BSSID: 68:19:..." - the
      # later BSSID field overwrote the real one.
      # The first field is "WifiInfo: SSID: \"x\"", so an anchored ^SSID: test is
      # too strict; what must be excluded is BSSID.
      if (t !~ /BSSID:/ && t ~ /SSID:/) {
        sub(/.*SSID:[ \t]*"/, "", t)
        sub(/".*/, "", t)
        l_ssid = t
      }
    }
    next
  }

  if (f == "net.txt") {
    if ($0 ~ /^gw=/)  { sub(/^gw=/, "", $0); net_gw = $0; next }
    if ($0 ~ /^dns=/) { sub(/^dns=/, "", $0); net_dns = $0; next }
    if ($0 ~ /packet loss/) {
      if (match($0, /[0-9]+% packet loss/)) {
        t = substr($0, RSTART, RLENGTH); sub(/%.*/, "", t); net_loss = t + 0
      }
      next
    }
    if ($0 ~ /rtt .*=/) {
      # "rtt min/avg/max/mdev = 1.2/2.4/3.6/0.8 ms" - target the block before
      # " ms" so max is not mistaken for avg.
      if (match($0, /=[ \t]*[0-9.]+\/[0-9.]+\/[0-9.]+\/[0-9.]+ ms/)) {
        t = substr($0, RSTART, RLENGTH)
        sub(/= */, "", t); sub(/ ms/, "", t)
        split(t, q, "/")
        net_rtt = q[2] + 0
      }
      next
    }
    next
  }
}

END {
  # ---- channel scoring: weighted interference per candidate channel ----
  # Counting APs alone is misleading (five APs at -80 matter less than one at
  # -25), so sum linear power: co-channel full weight, +/-4 channels (the 20 MHz
  # mask overlap) a quarter.
  b24 = (n24 > 0); b5 = (n5 > 0)
  if (b24) for (c = 1; c <= 13; c++) cand[c] = 1
  if (b5) {
    for (c = 36; c <= 64; c += 4)  cand[c] = 1
    for (c = 100; c <= 144; c += 4) cand[c] = 1
    for (c = 149; c <= 165; c += 4) cand[c] = 1
  }
  for (c in cnt) cand[c] = 1

  nsc = 0
  # c comes from an array *key*, so awk hands it back as a string: "4" > "34" is
  # true lexicographically, which silently sorted 2.4GHz channels ahead of 5GHz
  # ones. Force numeric on the way in.
  for (c in cand) { nsc++; s_ch[nsc] = c + 0; s_ld[nsc] = ld[c] + 0; s_dfs[nsc] = is_dfs(c + 0) }

  # Order: 5GHz before 2.4GHz, then non-DFS before DFS, then least
  # interference, then observed channels, then channel number.
  #
  # Both groups come before load on purpose:
  #  - Band: 2.4GHz has three non-overlapping channels shared by everything in
  #    range, so a "clean" ch1 is a worse pick than a busy 5GHz channel. Sorting
  #    by load alone recommended ch1 whenever a scan happened to see nothing
  #    there.
  #  - DFS: an empty DFS channel scores zero but is the worst advice we could
  #    give - passive scan only, and a radar hit vacates it. Sorting on load
  #    alone always answered "ch 108" on the reference capture.
  for (i = 1; i <= nsc; i++) {
    m = i
    for (j = i + 1; j <= nsc; j++) {
      bj = (s_ch[j] > 34) ? 1 : 0
      bm = (s_ch[m] > 34) ? 1 : 0
      if (bj != bm) { if (bj) m = j; continue }
      if (s_dfs[j] != s_dfs[m]) { if (!s_dfs[j]) m = j; continue }
      if (s_ld[j] != s_ld[m])   { if (s_ld[j] < s_ld[m]) m = j; continue }
      if ((s_ch[j] in cnt) != (s_ch[m] in cnt)) { if (s_ch[j] in cnt) m = j; continue }
      if (s_ch[j] < s_ch[m]) m = j
    }
    if (m != i) {
      t = s_ld[i]; s_ld[i] = s_ld[m]; s_ld[m] = t
      t = s_ch[i]; s_ch[i] = s_ch[m]; s_ch[m] = t
      t = s_dfs[i]; s_dfs[i] = s_dfs[m]; s_dfs[m] = t
    }
  }

  # ---- AP table: strongest first (order matters for the UI) ----
  for (i = 1; i <= na; i++) {
    m = i
    for (j = i + 1; j <= na; j++) if (a_rssi[j] > a_rssi[m]) m = j
    if (m != i) {
      t = a_ssid[i]; a_ssid[i] = a_ssid[m]; a_ssid[m] = t
      t = a_rssi[i]; a_rssi[i] = a_rssi[m]; a_rssi[m] = t
      t = a_freq[i]; a_freq[i] = a_freq[m]; a_freq[m] = t
      t = a_ch[i];   a_ch[i]   = a_ch[m];   a_ch[m]   = t
      t = a_age[i];  a_age[i]  = a_age[m];  a_age[m]  = t
      t = a_dfs[i];  a_dfs[i]  = a_dfs[m];  a_dfs[m]  = t
      t = a_band[i]; a_band[i] = a_band[m]; a_band[m] = t
      t = a_unii[i]; a_unii[i] = a_unii[m]; a_unii[m] = t
    }
  }

  if (out_fmt == "json") emit_json()
  else                   emit_text()
}

# ---------------------------------------------------------------------------
# Renderers. Both read the same computed state, so the human-readable report
# and the machine-readable document can never disagree.
# ---------------------------------------------------------------------------

function emit_json(   i, j, m, t, lim, nc, nr, dfs_v, net_v) {
  printf "{\n"
  printf "  \"schema\":%d,\n", schema
  printf "  %s,\n", pair("generated", strftime("%Y-%m-%dT%H:%M:%S"))

  printf "  \"summary\":{"
  printf "%s,%s,%s,%s,", num("total", n), num("n24", n24), num("n5", n5), num("n6", n6)
  printf "%s,%s,%s,%s,", num("ndfs", ndfs), num("nunii2a", nu2a), num("nunii2c", nu2c), num("nunii3", nu3)
  printf "%s,%s", num("nwpa3", nw3), num("nopen", nopen)
  printf "},\n"

  printf "  \"best\":{%s,%s,%s},\n", \
    num("rssi", best), pair("ssid", best_ssid), num("freq", best_freq)

  printf "  \"link\":{"
  printf "%s,%s,%s,%s,", num("freq", l_freq), num("channel", l_freq ? chan_of(l_freq) : 0), \
                          num("rssi", l_rssi), num("link_mbps", l_mbps)
  printf "%s,%s", pair("quality", l_rssi ? quality(l_rssi) : ""), pair("standard", l_std)
  printf "},\n"

  printf "  \"link_ssid\":%s,\n", "\"" esc(l_ssid) "\""

  printf "  \"scan\":{%s,%s},\n", num("age_max", age_max), num("aps", n)

  printf "  \"channels\":{\"dfs\":["
  for (i = 1; i <= ndfsch; i++) printf "%s%d", (i > 1 ? "," : ""), dfs_ch[i]
  printf "]},\n"

  printf "  \"score\":[\n"
  lim = (nsc > 10) ? 10 : nsc
  for (i = 1; i <= lim; i++) {
    printf "    {\"ch\":%d,\"load\":%.0f,\"co\":%d,\"adj\":%d,\"dfs\":%d%s}%s\n", \
      s_ch[i], s_ld[i], co_n[s_ch[i]] + 0, adj_n[s_ch[i]] + 0, s_dfs[i], \
      (s_ch[i] in cnt ? ",\"seen\":true" : ",\"seen\":false"), \
      (i < lim ? "," : "")
  }
  printf "  ],\n"

  printf "  \"congestion\":["
  nc = 0; for (c in cnt) cong_l[++nc] = c + 0     # same string-key trap as s_ch
  for (i = 1; i <= nc; i++) {
    m = i
    for (j = i + 1; j <= nc; j++) if (cong[cong_l[j]] > cong[cong_l[m]]) m = j
    if (m != i) { t = cong_l[i]; cong_l[i] = cong_l[m]; cong_l[m] = t }
  }
  lim = (nc > 12) ? 12 : nc
  for (i = 1; i <= lim; i++)
    printf "%s{\"ch\":%d,\"count\":%d}", (i > 1 ? "," : ""), cong_l[i], cong[cong_l[i]]
  printf "],\n"

  printf "  \"aps\":[\n"
  for (i = 1; i <= na; i++) {
    printf "    {\"ssid\":\"%s\",\"freq\":%d,\"ch\":%d,\"rssi\":%d,\"age\":%d,\"dfs\":%s,\"band\":\"%s\",\"unii\":\"%s\"}%s\n", \
      esc(a_ssid[i]), a_freq[i], a_ch[i], a_rssi[i], a_age[i], \
      (a_dfs[i] ? "true" : "false"), a_band[i], a_unii[i], (i < na ? "," : "")
  }
  printf "  ],\n"

  nr = 0
  for (s in bss_cnt) if (bss_cnt[s] > 1) { nr++; roam_s[nr] = s; roam_n[nr] = bss_cnt[s] }
  printf "  \"roam\":{\"multi\":%d,\"ssids\":[", nr
  for (i = 1; i <= nr; i++)
    printf "%s{\"ssid\":\"%s\",\"bssids\":%d}", (i > 1 ? "," : ""), esc(roam_s[i]), roam_n[i]
  printf "]},\n"

  printf "  \"net\":{"
  printf "%s,%s,%s,%s", pair("gateway", net_gw), \
    (net_loss == "" ? "\"loss\":null" : num("loss", net_loss)), \
    (net_rtt == "" ? "\"rtt_ms\":null" : num("rtt_ms", net_rtt)), pair("dns", net_dns)
  printf "  },\n"

  # Verdict keeps two independent axes: RF reachability and L3 health.
  if (n5 > 0 && ndfs > 0)      dfs_v = "ok"
  else if (n5 > 0)             dfs_v = "none"
  else                         dfs_v = "nodata"

  if (net_loss == "" )         net_v = "nogw"
  else if (net_loss + 0 == 0)  net_v = "ok"
  else                         net_v = "lossy"

  printf "  \"verdict\":{"
  printf "%s,%s,%s,%s", pair("dfs", dfs_v), pair("net", net_v), \
    pair("dns_l3", (net_dns == "" ? "unknown" : net_dns)), \
    (nsc > 0 ? num("best_ch", s_ch[1]) : "\"best_ch\":null")
  printf "}\n"

  printf "}\n"
}

function emit_text(   i, j, m, t, lim, dfs_v, net_v, dfs_str) {
  printf "# KsuFastSurfing wifidiag report %s\n", strftime("%Y-%m-%d %H:%M:%S")
  printf "# sections: summary / rf / link / channel / scan / score / roam / congestion / aps / net / verdict\n"

  printf "[summary]\n"
  printf "total=%d\nn24=%d\nn5=%d\nn6=%d\n", n, n24, n5, n6
  printf "ndfs=%d\nnunii2a=%d\nnunii2c=%d\nnunii3=%d\n", ndfs, nu2a, nu2c, nu3
  printf "nwpa3=%d\nnopen=%d\n", nw3, nopen
  printf "best=%d\nbest_ssid=%s\nbest_freq=%d\n", best, best_ssid, best_freq
  dfs_str = ""
  for (i = 1; i <= ndfsch; i++) dfs_str = dfs_str " " dfs_ch[i]
  printf "dfs_ch=%s\n", dfs_str

  printf "[rf]\n"
  printf "best_rssi=%d\n", best
  printf "quality=%s\n", (n > 0 ? quality(best) : "unknown")

  printf "[link]\n"
  printf "freq=%d\nconn_ch=%d\nlink_mbps=%d\nrssi=%d\n", l_freq, (l_freq ? chan_of(l_freq) : 0), l_mbps, l_rssi
  printf "conn_quality=%s\nstandard=%s\nssid=%s\n", (l_rssi ? quality(l_rssi) : ""), l_std, l_ssid

  printf "[channel]\n"
  printf "dfs_ch=%s\n", dfs_str

  printf "[scan]\n"
  printf "age_max=%d\naps=%d\n", age_max, n

  printf "[score]\n"
  lim = (nsc > 8) ? 8 : nsc
  for (i = 1; i <= lim; i++)
    printf "sc %d|%.0f|%d|%d|%d|%d\n", s_ch[i], s_ld[i], co_n[s_ch[i]] + 0, adj_n[s_ch[i]] + 0, s_dfs[i], (s_ch[i] in cnt) ? 1 : 0

  printf "[roam]\n"
  nr = 0
  for (s in bss_cnt) if (bss_cnt[s] > 1) { nr++; roam_s[nr] = s; roam_n[nr] = bss_cnt[s] }
  printf "multi=%d\nlist=", nr
  if (nr == 0) printf "-\n"
  else {
    for (i = 1; i <= nr; i++) printf "%s%s:%d", (i > 1 ? "," : ""), roam_s[i], roam_n[i]
    printf "\n"
  }

  printf "[congestion]\n"
  nc = 0; for (c in cnt) cong_l[++nc] = c + 0
  for (i = 1; i <= nc; i++) {
    m = i
    for (j = i + 1; j <= nc; j++) if (cong[cong_l[j]] > cong[cong_l[m]]) m = j
    if (m != i) { t = cong_l[i]; cong_l[i] = cong_l[m]; cong_l[m] = t }
  }
  lim = (nc > 12) ? 12 : nc
  for (i = 1; i <= lim; i++) printf "ch%d=%d\n", cong_l[i], cong[cong_l[i]]

  printf "[aps]\n"
  for (i = 1; i <= na; i++)
    printf "ap %s|%d|%d|%d|%d|%d\n", a_ssid[i], a_freq[i], a_ch[i], a_rssi[i], a_age[i], a_dfs[i]

  printf "[net]\n"
  printf "gw=%s\n", (net_gw == "" ? "none" : net_gw)
  printf "loss=%s\n", (net_loss == "" ? "none" : net_loss)
  printf "gw_rtt=%s\n", (net_rtt == "" ? "none" : net_rtt)
  printf "dns=%s\n", (net_dns == "" ? "unknown" : net_dns)

  printf "[verdict]\n"
  if (n5 > 0 && ndfs > 0) dfs_v = "ok"
  else if (n5 > 0)        dfs_v = "none"
  else                    dfs_v = "nodata"
  printf "dfs=%s\n", dfs_v
  if (dfs_v == "ok")        printf "note=DFS channels visible; if the UI hides them it is a scan-cache issue\n"
  else if (dfs_v == "none") printf "note=5GHz present but no DFS AP nearby; move closer and rescan\n"
  else                      printf "note=no 5GHz found at all\n"

  if (net_loss == "")        net_v = "nogw"
  else if (net_loss + 0 == 0) net_v = "ok"
  else                        net_v = "lossy"
  printf "net=%s\n", net_v
  printf "dns_l3=%s\n", (net_dns == "" ? "unknown" : net_dns)
  printf "best_ch=%s\n", (nsc > 0 ? s_ch[1] : "none")
}