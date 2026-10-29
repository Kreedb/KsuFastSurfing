#!/system/bin/sh
# WiFi diagnostics: collect -> analyse -> render.
# Everything is read from interfaces present on stock Android (no iw, no root
# tools beyond what KernelSU gives us).
#
# Subcommands:
#   collect       gather raw data into the diag dir
#   report        analysis as key=value sections (human / grep friendly)
#   json          analysis as one JSON document (what the WebUI consumes)
#   scan          collect + text report (default)
#   json-cached   re-render the last collection (tests, replay)
#
# Parsing and rendering are done by wifidiag.awk (with jsonlib.awk) in a single
# pass. That is deliberate: the scan cache is column aligned and SSIDs may
# contain any character, so any shell-side field joining reintroduces the
# column-shift bug the JSON format was introduced to kill.
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
# Analysis and rendering live in wifidiag.awk, not in shell. The previous
# version built the report with a dozen inline awk programs and joined fields
# with '|', which silently reshuffled columns for any SSID containing '|' or
# '='. One awk pass also means the text report and the JSON document are
# rendered from the same computed state and cannot drift apart.
run_report() {
  # $1 = text|json
  [ -s "$RAW/scan.txt" ] || {
    if [ "$1" = "json" ]; then
      printf '{"schema":%d,"error":"no-scan","summary":{"total":0}}\n' 1
    else
      echo "error=no-scan"
    fi
    return 1
  }
  # link.txt / net.txt may be absent (not connected, no gateway); awk skips a
  # missing file rather than failing.
  for f in "$RAW/link.txt" "$RAW/net.txt"; do
    [ -f "$f" ] || : > "$f"
  done
  awk -f "$MODDIR/jsonlib.awk" -f "$MODDIR/wifidiag.awk" -v out_fmt="$1" \
    "$RAW/scan.txt" "$RAW/link.txt" "$RAW/net.txt"
}

report()      { run_report text; }
json_report() { run_report json; }

case "$1" in
  collect) collect ;;
  report)  report ;;
  raw)     report ;;
  json)
    collect >/dev/null
    json_report
    ;;
  json-cached)
    json_report
    ;;
  scan|"")  collect >/dev/null; report ;;
  api)
    # Kept for compatibility with the previous WebUI build: emits key=value.
    # New callers should use `json`.
    collect >/dev/null
    report
    ;;
  api-cached)
    report
    ;;
  *) echo "usage: wifidiag.sh {scan|collect|report|json|api}"; exit 2 ;;
esac
