#!/system/bin/sh
# WiFi diagnostics: collect -> parse -> analyse -> render as key=value.
# Everything is read from interfaces present on stock Android (no iw, no root
# tools beyond what KernelSU gives us).
#
# Subcommands:
#   collect        gather raw data into the diag dir
#   report         print the machine-readable analysis (key=value)
#   scan           collect + report (default)
#   json <file>    re-analyse a saved raw dump (used by tests on the desktop)
case "$0" in */*) MODDIR=${0%/*} ;; *) MODDIR=. ;; esac
PATH=/data/adb/ksu/bin:/system/bin:/system/xbin:$PATH

D="$MODDIR/diag"
RAW="$D/raw"
OUT="$D/report.txt"
LOG="$MODDIR/wifidiag.log"

mkdir -p "$RAW" 2>/dev/null
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

collect() {
  : > "$RAW/status.txt"
  : > "$RAW/scan.txt"
  : > "$RAW/dumpsys.txt"
  : > "$RAW/link.txt"

  cmd wifi status        > "$RAW/status.txt" 2>&1
  cmd wifi list-scan-results > "$RAW/scan.txt" 2>&1
  dumpsys wifi           > "$RAW/dumpsys.txt" 2>&1
  # per-network detail (only for the connected one)
  ssid=$(sed -n 's/.*Wifi is connected to "\(.*\)".*/\1/p' "$RAW/status.txt" | head -1)
  [ -n "$ssid" ] && cmd wifi status 2>/dev/null | grep -m1 'WifiInfo:' > "$RAW/link.txt"

  # L3 probe: a connected Wi-Fi is not a working one. Gateway RTT/loss separates
  # "weak RF" from "bad AP uplink", and a DNS lookup separates "DNS broken" from
  # "no internet". Kept short so a scan stays interactive.
  : > "$RAW/net.txt"
  gw=$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')
  [ -n "$gw" ] || gw=$(cmd wifi status 2>/dev/null | sed -n 's/.*gateway: *\([0-9.]*\).*/\1/p' | head -1)
  echo "gw=$gw" >> "$RAW/net.txt"
  if [ -n "$gw" ]; then
    ping -c 5 -i 0.2 -W 1 "$gw" 2>/dev/null | tail -3 >> "$RAW/net.txt"
  fi
  # ping does the lookup itself, so one call tests DNS + reachability at once.
  ping -c 1 -W 2 github.com > /dev/null 2>&1 && echo "dns=ok" >> "$RAW/net.txt" || echo "dns=fail" >> "$RAW/net.txt"

  log "collected ssid=${ssid:-none} gw=${gw:-none}"
  echo "$ssid"
}

# Parse the scan cache. Stock output is space separated:
# BSSID  Frequency  RSSI(link:rssi0/rssi1)  Age  SSID  Flags
# SSID can contain spaces, so fields are taken from both ends.
parse_scan() {
  awk '
    function num(x){ x = $0; sub(/^\(.*/,"",x); return int(x) }
    function rssi_of(x){ sub(/\(.*/,"",x); return int(x) }
    NR == 1 { next }
    NF < 5 { next }
    {
      freq = $2 + 0
      if (freq < 2400) next
      if (freq <= 2500)      band = "2.4"
      else if (freq < 4900)  next
      else if (freq <= 5895) band = "5"
      else if (freq <= 5925) band = "5"
      else                   band = "6"

      rssi = rssi_of($3)
      age  = int($4)

      # SSID sits between the age field and the Flags column
      ssid = ""
      for (i = 5; i <= NF; i++) {
        if ($i ~ /^\[/) break
        ssid = (ssid == "" ? $i : ssid " " $i)
      }
      if (ssid == "null") ssid = ""
      flags = ""
      for (; i <= NF; i++) flags = flags $i

      ch = int((freq - 5000) / 5)
      if (band == "2.4") ch = (freq == 2484) ? 14 : int((freq - 2407) / 5)
      if (band == "6")   ch = int((freq - 5950) / 5)

      dfs = 0
      if (band == "5" && ((ch >= 52 && ch <= 64) || (ch >= 100 && ch <= 144))) dfs = 1
      unii3 = (band == "5" && ch >= 149) ? 1 : 0

      wpa3 = (flags ~ /SAE/) ? 1 : 0
      wpa2 = (flags ~ /RSN-PSK|WPA2/) ? 1 : 0
      wpa  = (flags ~ /WPA-PSK/) ? 1 : 0
      open = (flags !~ /RSN|WPA/) ? 1 : 0

      n++
      if (band == "2.4") n24++
      if (band == "5")   n5++
      if (band == "6")   n6++
      if (dfs) { ndfs++; if (!seen_dfs[ch]++) dfs_ch = dfs_ch " " ch }
      if (unii3) nu3++
      if (wpa3) nw3++
      if (open) nopen++

      if (n == 1 || rssi > best) { best = rssi; best_ssid = ssid; best_freq = freq }

      if (ssid != "" && !(ssid in seen)) {
        seen[ssid] = 1
        printf "AP\t%s\t%d\t%d\t%d\t%d\t%d\t%.0f\t%s\n", ssid, freq, ch, rssi, age, dfs, 0, band
      }
    }
    END {
      printf "SUM\ttotal=%d\tn24=%d\tn5=%d\tn6=%d\tndfs=%d\tnu3=%d\tnw3=%d\tnopen=%d\tbest=%.0f\tbest_ssid=%s\tbest_freq=%d\tdfs_ch=%s\n",
        n, n24, n5, n6, ndfs, nu3, nw3, nopen, best, best_ssid, best_freq, dfs_ch
    }
  ' "$1" 2>/dev/null
}

report() {
  scan_file="$RAW/scan.txt"
  st_file="$RAW/status.txt"
  dy_file="$RAW/dumpsys.txt"

  [ -s "$scan_file" ] || { echo "error=no-scan"; return 1; }

  sc=$(parse_scan "$scan_file")
  sum=$(echo "$sc" | grep '^SUM' | cut -f2-)
  aps=$(echo "$sc" | grep '^AP' | cut -f2-)

  echo "# KsuFastSurfing wifidiag report $(date '+%Y-%m-%d %H:%M:%S')"
  echo "# sections: summary / rf / security / channel / link / verdict"

  echo "[summary]"
  echo "$sum" | tr '\t' '\n'
  echo "[rf]"
  best=$(echo "$sum" | tr '\t' '\n' | sed -n 's/^best=//p')
  echo "best_rssi=$best"
  case "$best" in
    ''|0) echo "quality=unknown" ;;
    -*)  if [ "$best" -ge -50 ]; then q=excellent
         elif [ "$best" -ge -60 ]; then q=good
         elif [ "$best" -ge -70 ]; then q=fair
         else q=weak; fi
         echo "quality=$q" ;;
  esac

  echo "[link]"
  if [ -s "$RAW/link.txt" ]; then
    awk '
      BEGIN { FS="," }
      /Frequency:/ { for(i=1;i<=NF;i++){ if($i ~ /Frequency:/){ gsub(/[^0-9]/,"",$i); print "freq="$i;
                       c = ($i <= 2500) ? (($i == 2484) ? 14 : int(($i - 2407) / 5)) : int(($i - 5000) / 5);
                       print "conn_ch="c } } }
      /Link speed:/ { for(i=1;i<=NF;i++){ if($i ~ /Link speed:/){ gsub(/[^0-9]/,"",$i); print "link_mbps="$i } } }
      /RSSI:/ { for(i=1;i<=NF;i++){ if($i ~ /RSSI:/){ gsub(/[^0-9-]/,"",$i); print "rssi="$i;
                 r = $i + 0;
                 q = (r >= -50) ? "excellent" : (r >= -60) ? "good" : (r >= -70) ? "fair" : "weak";
                 print "conn_quality="q } } }
      /Wi-Fi standard: 11/ { match($0, /11[a-z0-9]+/); print "standard="substr($0,RSTART,RLENGTH) }
      /SSID: "/ { match($0,/SSID: "[^"]*"/); s=substr($0,RSTART+7,RLENGTH-8); print "ssid="s }
    ' "$RAW/link.txt"
  else
    echo "ssid="
  fi

  echo "[channel]"
  echo "$sum" | tr '\t' '\n' | grep -E '^dfs_ch='

  # Scan freshness: the framework keeps a cached BSS list and reuses it, so the
  # Age column is the only honest answer to "is this data live?".
  echo "[scan]"
  awk 'NR == 1 { next } NF < 5 { next } { a = int($4); if (a > mx) mx = a; n++ }
       END { printf "age_max=%d\naps=%d\n", mx + 0, n + 0 }' "$scan_file"

  # Interference score per channel. Counting APs is not enough: 5 APs at -80 are
  # harmless, one AP at -25 is not. We sum linear power, weighting co-channel
  # fully and channels within +-4 (20 MHz mask overlap) at a quarter.
  echo "[score]"
  score_out=$(awk '
    # Linear power from dBm without ^: busybox/toybox awk on Android is built
    # without math support ("Math support is not compiled in"), so 10^(r/10)
    # aborts on device. Instead we work in integer units where 1 unit = the power
    # of -100 dBm and one 0.5 dB step = 1.122x. This keeps everything exact enough
    # for ranking and avoids printing "0.00" for every real AP: -85 dBm is 31,
    # -67 is 1995, -25 is 31.6 million.
    function pw(r,   v, k) {
      k = int((r + 100) * 2)
      if (k < 0) return 0
      if (k > 440) k = 440          # ceiling at -100+220 dBm; never realistic
      v = 1
      while (k-- > 0) v *= 1.122
      return v
    }
    NR == 1 { next }
    NF < 5 { next }
    {
      f = $2 + 0
      if (f < 2400) next
      if (f <= 2500)      c = (f == 2484) ? 14 : int((f - 2407) / 5)
      else if (f <= 5895) c = int((f - 5000) / 5)
      else                c = int((f - 5950) / 5)
      x = $3; sub(/\(.*/, "", x); r = int(x)
      p = pw(r)
      if (!(c in seen)) { seen[c] = 1; cand[c] = 1 }
      co[c]++
      load[c] += p
      if (c <= 14) { b24 = 1 } else if (c >= 36) { b5 = 1 }
      for (d = -4; d <= 4; d++) {
        if (d == 0) continue
        k = c + d
        if (k < 1) continue
        adj[k]++
        aload[k] += p / 4
      }
    }
    END {
      if (b24) for (i = 1; i <= 13; i++) cand[i] = 1
      if (b5) {
        for (i = 36; i <= 64; i += 4)  cand[i] = 1
        for (i = 100; i <= 144; i += 4) cand[i] = 1
        for (i = 149; i <= 165; i += 4) cand[i] = 1
      }
      for (c in cand) {
        tot = load[c] + aload[c]
        dfs = (c >= 52 && c <= 64) || (c >= 100 && c <= 144) ? 1 : 0
        n++
        ch[n] = c; ld[n] = tot; co_n[n] = co[c] + 0; adj_n[n] = adj[c] + 0
        dfs_n[n] = dfs; seen_n[n] = (c in seen) ? 1 : 0
      }
      # Sort order: non-DFS before DFS first, then least weighted interference,
      # then an observed channel before an unscanned one, then channel number.
      # Grouping on DFS *before* interference matters: an empty DFS channel scores
      # zero but is the worst recommendation we could make - it scans passively
      # (slow discovery, invisible hidden SSIDs) and vacates for radar. Ranked by
      # load alone the tool would always answer "ch 108", which is useless advice
      # even though the arithmetic is right.
      for (i = 1; i <= n; i++) {
        m = i
        for (j = i + 1; j <= n; j++) {
          if (dfs_n[j] != dfs_n[m]) { if (!dfs_n[j]) m = j; continue }
          if (ld[j] != ld[m]) { if (ld[j] < ld[m]) m = j; continue }
          if (seen_n[j] != seen_n[m]) { if (seen_n[j] > seen_n[m]) m = j; continue }
          if (ch[j] < ch[m]) m = j
        }
        if (m != i) {
          t = ld[i]; ld[i] = ld[m]; ld[m] = t
          t = ch[i]; ch[i] = ch[m]; ch[m] = t
          t = co_n[i]; co_n[i] = co_n[m]; co_n[m] = t
          t = adj_n[i]; adj_n[i] = adj_n[m]; adj_n[m] = t
          t = dfs_n[i]; dfs_n[i] = dfs_n[m]; dfs_n[m] = t
          t = seen_n[i]; seen_n[i] = seen_n[m]; seen_n[m] = t
        }
      }
      lim = (n > 8) ? 8 : n
      for (i = 1; i <= lim; i++)
        printf "sc %d|%.0f|%d|%d|%d|%d\n", ch[i], ld[i], co_n[i], adj_n[i], dfs_n[i], seen_n[i]
    }
  ' "$scan_file")
  echo "$score_out"

  # Multi-BSSID SSIDs: same SSID on several BSSIDs means mesh / multi-AP roaming,
  # which changes the advice (stick to one, don't fight the handoff).
  echo "[roam]"
  awk 'NR == 1 { next } NF < 5 { next }
    {
      ssid = ""
      for (i = 5; i <= NF; i++) { if ($i ~ /^\[/) break; ssid = (ssid == "" ? $i : ssid " " $i) }
      if (ssid == "" || ssid == "null") next
      if (!($1 in bss)) { bss[$1] = 1; cnt[ssid]++ }
    }
    END { m = 0
      for (s in cnt) if (cnt[s] > 1) { m++; line = line sprintf("%s:%d", (m > 1 ? "," : ""), cnt[s]) }
      printf "multi=%d\nlist=%s\n", m, (line == "" ? "-" : substr(line, 2))
    }' "$scan_file"

  # Congestion: how many BSSID share each primary channel. This is what makes
  # the tool useful - "45 APs" says little, "5 APs on ch36" says where to move.
  echo "[congestion]"
  awk '
    NR == 1 { next } NF < 5 { next }
    {
      f = $2 + 0
      if (f < 2400) next
      if (f <= 2500)      c = (f == 2484) ? 14 : int((f - 2407) / 5)
      else if (f <= 5895) c = int((f - 5000) / 5)
      else                c = int((f - 5950) / 5)
      cnt[c]++
    }
    END { for (c in cnt) printf "ch%s=%d\n", c, cnt[c] }
  ' "$scan_file" | sort -t= -k2 -n | head -12

  # Per-AP detail, strongest first (callers use this for the UI table).
  echo "[aps]"
  # busybox sort lacks multi-char -t, so sort on a plain space-separated key
  echo "$aps" | awk -F'\t' '{
      printf "ap %s|%s|%s|%s|%s|%s\n", $1, $2, $3, $4, $5, $6
    }' | sort -t'|' -k4 -rn | head -25 
  # L3: gateway reachability / loss / DNS. This is where "Wi-Fi bar is full but
  # nothing loads" gets diagnosed instead of guessed at.
  echo "[net]"
  if [ -s "$RAW/net.txt" ]; then
    gw=$(sed -n 's/^gw=//p' "$RAW/net.txt" | head -1)
    echo "gw=$gw"
    # busybox ping summary: "5 packets transmitted, 5 packets received, 0% packet loss"
    loss=$(sed -n 's/.* \([0-9]*\)% packet loss.*/\1/p' "$RAW/net.txt" | head -1)
    [ -n "$loss" ] && echo "loss=$loss" || echo "loss=none"
    # rtt line: "rtt min/avg/max/mdev = 1.2/3.4/5.6/0.9 ms" -> field 2 is avg.
    # A greedy sed regex would silently pick max (it did, during testing).
    avg=$(sed -n 's#.*= *\([0-9.]*\)/\([0-9.]*\)/\([0-9.]*\)/\([0-9.]*\) ms.*#\2#p' "$RAW/net.txt" | head -1)
    [ -n "$avg" ] && echo "gw_rtt=$avg" || echo "gw_rtt=none"
    dns=$(sed -n 's/^dns=//p' "$RAW/net.txt" | head -1)
    echo "dns=${dns:-unknown}"
  else
    loss=none; dns=unknown
    echo "gw=none"; echo "loss=none"; echo "gw_rtt=none"; echo "dns=unknown"
  fi

  echo "[verdict]"
  n24=$(echo "$sum" | tr '\t' '\n' | sed -n 's/^n24=//p')
  n5=$(echo "$sum" | tr '\t' '\n' | sed -n 's/^n5=//p')
  ndfs=$(echo "$sum" | tr '\t' '\n' | sed -n 's/^ndfs=//p')
  if [ "${n5:-0}" -gt 0 ] && [ "${ndfs:-0}" -gt 0 ]; then
    echo "dfs=ok"
    echo "note=DFS channels visible; if the UI hides them it is a scan-cache issue"
  elif [ "${n5:-0}" -gt 0 ]; then
    echo "dfs=none"
    echo "note=5GHz present but no DFS AP nearby; move closer and rescan"
  else
    echo "dfs=nodata"
    echo "note=no 5GHz found at all"
  fi

  # Network-level verdict, independent of RF. A full-bar link with 40% loss is a
  # worse experience than a weak link with clean packets, so report both.
  # loss/dns were computed in the [net] block above; reuse them instead of
  # re-reading net.txt (which holds raw ping output, not key=value pairs).
  case "${loss:-none}" in
    none) echo "net=nogw" ;;
    0)    echo "net=ok" ;;
    *)    echo "net=lossy" ;;
  esac
  case "${dns:-unknown}" in
    ok)  echo "dns_l3=ok" ;;
    fail) echo "dns_l3=fail" ;;
    *)   echo "dns_l3=unknown" ;;
  esac

  # Best pick: the score table is already sorted by weighted interference, so the
  # first row is the answer. Reported only when there is something to say.
  pick=$(echo "$score_out" | sed -n '1s/^sc \([0-9]*\)|.*/\1/p')
  if [ -n "$pick" ]; then
    echo "best_ch=$pick"
  else
    echo "best_ch=none"
  fi

  return 0
}

case "$1" in
  collect) collect ;;
  report)  report ;;
  json|raw) report ;;
  scan|"")  collect >/dev/null; report ;;
  api)
    # Machine interface for the WebUI: full report, unfiltered. The page needs
    # the [congestion] and ap rows too, so we must not strip sections here.
    collect >/dev/null
    report
    ;;
  api-cached)
    # Same shape but without collecting - used for replaying a saved dump.
    report
    ;;
  *) echo "usage: wifidiag.sh {scan|collect|report|api}"; exit 2 ;;
esac
