#!/system/bin/sh
# Probe candidate IPs for each hostname locally and keep the fastest one that
# actually completes a TLS handshake. No cloud hosts list is involved: this
# measures the device's own network path, which is the only thing that matters.
#
# Usage: probe.sh            -> writes $MODDIR/probed-hosts
#        probe.sh --print    -> also print the table
case "$0" in */*) MODDIR=${0%/*} ;; *) MODDIR=. ;; esac
PATH=/data/adb/ksu/bin:/system/bin:/system/xbin:$PATH

CONF="$MODDIR/config"
OUT="$MODDIR/probed-hosts"
LOG="$MODDIR/probe.log"
TMPD="$MODDIR/.probe"
PRINT=0
[ "$1" = "--print" ] && PRINT=1

log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }

conf_get() {
  v=$(sed -n "s/^$1=//p" "$CONF" 2>/dev/null | tail -1 | tr -d '\r')
  [ -n "$v" ] && echo "$v" || echo "$2"
}

TIMEOUT=$(conf_get PROBE_TIMEOUT 3)
THREADS=$(conf_get PROBE_THREADS 8)
case "$TIMEOUT" in ''|*[!0-9]*) TIMEOUT=3 ;; esac
case "$THREADS" in ''|*[!0-9]*|0) THREADS=8 ;; esac
[ "$TIMEOUT" -lt 1 ] 2>/dev/null || TIMEOUT=3
[ "$TIMEOUT" -gt 20 ] 2>/dev/null && TIMEOUT=20
[ "$THREADS" -gt 32 ] 2>/dev/null && THREADS=32

DOMAINS="$MODDIR/domains"
if [ -s "$DOMAINS" ]; then
  LIST=$(grep -vE '^[[:space:]]*(#|$)' "$DOMAINS")
else
  LIST="github.com
api.github.com
codeload.github.com
raw.githubusercontent.com
gist.github.com
objects.githubusercontent.com
mtalk.google.com
alt1-mtalk.google.com
alt2-mtalk.google.com
alt3-mtalk.google.com
dl.google.com
dl.l.google.com"
fi

mkdir -p "$TMPD" 2>/dev/null
rm -f "$TMPD"/* 2>/dev/null
: > "$LOG"

have_curl=0
command -v curl >/dev/null 2>&1 && have_curl=1
if [ "$have_curl" = "0" ]; then
  log "curl not found - cannot probe"
  echo "error=no-curl"
  exit 1
fi

# Candidate IPs: whatever DNS returns on this device, plus nothing invented.
dns_ips() {
  h="$1"
  if command -v getent >/dev/null 2>&1; then
    getent hosts "$h" 2>/dev/null | awk '{print $1}'
  elif command -v nslookup >/dev/null 2>&1; then
    nslookup "$h" 2>/dev/null | awk '/^Address: /{print $2}'
  fi
}

probe_one() {
  # $1 host  $2 ip  -> prints "<time> <host> <ip>" on success
  h="$1"; ip="$2"
  t=$(curl -sS -o /dev/null -k \
        --connect-timeout "$TIMEOUT" --max-time "$((TIMEOUT * 2))" \
        --resolve "$h:443:$ip" -w '%{time_total}' \
        "https://$h/" 2>/dev/null)
  rc=$?
  case "$t" in ''|*[!0-9.]*) return 1 ;; esac
  [ "$rc" = "0" ] || return 1
  echo "$t $h $ip"
}

# Build the (host, ip) work list first, one line per pair.
: > "$TMPD/work"
: > "$TMPD/queue"
for h in $LIST; do
  n=0
  for ip in $(dns_ips "$h"); do
    case "$ip" in *:*) continue ;; esac   # IPv4 only: cheap and enough here
    echo "$h $ip" >> "$TMPD/queue"
    n=$((n + 1))
  done
  [ "$n" = "0" ] && log "no DNS answer for $h"
done
total=$(wc -l < "$TMPD/queue" | tr -d ' ')
log "pairs=$total timeout=${TIMEOUT}s threads=$THREADS"
echo "pairs=$total"

run_pool() {
  i=0
  while read -r h ip; do
    [ -n "$h" ] || continue
    probe_one "$h" "$ip" >> "$TMPD/work" &
    i=$((i + 1))
    if [ $((i % THREADS)) -eq 0 ]; then
      wait
    fi
  done < "$TMPD/queue"
  wait
}
run_pool

# Keep the fastest successful probe per host.
if [ -s "$TMPD/work" ]; then
  sort -n "$TMPD/work" | awk '!seen[$2]++ {print $3"\t"$2}' > "$TMPD/best"
else
  : > "$TMPD/best"
fi

{
  echo "# probed $(date '+%Y-%m-%d %H:%M:%S') timeout=${TIMEOUT}s threads=$THREADS"
  echo "# format: IP<TAB>host  (fastest TLS handshake measured on this device)"
  if [ -s "$TMPD/best" ]; then
    cat "$TMPD/best"
  else
    echo "# (no reachable candidate IP)"
  fi
} > "$OUT"

ok=$(grep -c '^[0-9]' "$OUT" 2>/dev/null || echo 0)
log "resolved $ok host(s)"
echo "ok=$ok"
if [ "$PRINT" = "1" ]; then
  echo "--- best ---"
  sed -n 's/^\([0-9.]*\)\t\(.*\)/\2 \1/p' "$OUT"
fi
rm -rf "$TMPD" 2>/dev/null
exit 0
