#!/system/bin/sh
# Probe candidate IPs for each hostname on this device and keep the fastest
# reachable one. No cloud hosts list is involved.
#
# Candidate discovery and ranking follow the two reference implementations:
#   maxiaof/github-hosts  - resolve through DoH (Cloudflare JSON API)
#   yangFenTuoZi/fcm-hosts - union candidates from several resolvers, then
#                            rank them by connection time to port 443
#
# The previous version only asked the system resolver (`getent`, `nslookup`) and
# then required a full HTTPS round trip. Retail Android ships neither getent nor
# nslookup, so the candidate list came out empty and every run reported
# "0 candidates, all unreachable" - the resolver was missing, not the network.
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

# ---------------------------------------------------------------------------
# Candidate discovery
# ---------------------------------------------------------------------------

# Plain-text IPv4 answer from a DoH JSON response. The API returns
# {"Answer":[{"name":...,"type":1,"data":"1.2.3.4"}, ...]}; type 1 is A, and a
# CNAME answer carries a name in "data" instead, so the field is filtered by
# shape as well as by type.
doh_ips() {
  url="$1"
  # A blocked or hijacked DoH endpoint must cost one short timeout, not stall
  # the whole run: these are called per host and the answer is only a bonus
  # over what ping's own resolver already returned.
  dt=$TIMEOUT
  [ "$dt" -gt 2 ] 2>/dev/null && dt=2
  curl -sS -k --max-time "$dt" -H 'accept: application/dns-json' "$url" 2>/dev/null \
    | tr '{' '\n' \
    | grep -E '"type"[[:space:]]*:[[:space:]]*1[,}]' \
    | sed -n 's/.*"data"[[:space:]]*:[[:space:]]*"\([0-9][0-9.]*\)".*/\1/p'
}

dns_ips() {
  h="$1"
  {
    # System resolver, if this ROM happens to ship one.
    if command -v getent >/dev/null 2>&1; then
      getent hosts "$h" 2>/dev/null | awk '{print $1}'
    fi
    if command -v nslookup >/dev/null 2>&1; then
      nslookup "$h" 2>/dev/null | sed -n 's/^Address[^:]*:[[:space:]]*\([0-9][0-9.]*\)$/\1/p'
    fi
    # Toybox ping always exists and prints the resolved address in brackets.
    # This is the resolver that actually works on every retail ROM.
    ping -c 1 -W "$TIMEOUT" "$h" 2>/dev/null \
      | sed -n 's/^PING [^(]*(\([0-9][0-9.]*\)).*/\1/p' | head -1

    # DoH, both providers, so one blocked resolver does not empty the list.
    doh_ips "https://cloudflare-dns.com/dns-query?name=$h&type=A"
    doh_ips "https://dns.google/resolve?name=$h&type=A"
  } 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u
}

# ---------------------------------------------------------------------------
# Probing
# ---------------------------------------------------------------------------

# One candidate. Prints "<connect> <host> <ip> <tls>" on success.
# Reachability is judged on time_connect, not on curl's exit code: a site that
# answers 403 or fails TLS still proves the path is up, and those were being
# thrown away before. time_appconnect != 0 additionally means the TLS handshake
# completed, which is what hosts redirection actually needs.
probe_one() {
  h="$1"; ip="$2"
  w=$(curl -sS -o /dev/null -k --connect-timeout "$TIMEOUT" --max-time "$((TIMEOUT * 2))" \
        --resolve "$h:443:$ip" -w '%{time_connect} %{time_appconnect}' \
        "https://$h/" 2>/dev/null)
  [ -n "$w" ] || return 1
  set -- $w
  conn=$1; tls=$2
  case "$conn" in ''|0|0.0|0.000000) return 1 ;; esac
  case "$tls" in ''|0|0.0|0.000000) tls=0 ;; *) tls=1 ;; esac
  printf '%s %s %s %s\n' "$conn" "$h" "$ip" "$tls"
}

# Build the (host, ip) work list first: the caller needs the count before the
# first probe starts so the UI can show an estimate.
: > "$TMPD/queue"
# Resolution is per host and each host may try two DoH endpoints, so doing it
# serially made a 12-domain list take over a minute before the first probe even
# started. Resolve in the same pool as the probing.
: > "$TMPD/res"
for h in $LIST; do
  # Create the file up front. A host with no answer must leave an empty file
  # behind, because that empty file is how the caller counts unresolved names -
  # "the file does not exist" cannot be told apart from "the shell skipped it".
  : > "$TMPD/res.$h"
  ( dns_ips "$h" | while read -r ip; do
      case "$ip" in *:*) continue ;; esac   # IPv4 only: cheap and enough here
      echo "$h $ip" >> "$TMPD/res.$h"
    done ) &
  i=$(( ${i:-0} + 1 ))
  if [ $((i % THREADS)) -eq 0 ]; then wait; fi
done
wait
for f in "$TMPD"/res.*; do
  [ -f "$f" ] || continue
  h=${f##*/res.}
  if [ -s "$f" ]; then sort -u "$f" >> "$TMPD/queue"; else
    log "no address for $h (system resolver, ping and DoH all failed)"
  fi
done
total=$(wc -l < "$TMPD/queue" | tr -d ' ')
# How many names could not be resolved at all. The caller needs this: "0 pairs
# because DNS is dead" and "0 pairs because every candidate timed out" look the
# same in the ok/tried numbers but need completely different advice.
nohost=0
for f in "$TMPD"/res.*; do
  [ -f "$f" ] && [ ! -s "$f" ] && nohost=$((nohost + 1))
done
log "pairs=$total nohost=$nohost timeout=${TIMEOUT}s threads=$THREADS"
# Timing matters to the caller: with N pairs and T threads the worst case is
# ceil(N/T) * (TIMEOUT*2) seconds, and the UI shows that as an estimate rather
# than leaving the user staring at a dead button.
echo "pairs=$total"
echo "nohost=$nohost"
echo "timeout=$TIMEOUT"
echo "threads=$THREADS"

if [ "$have_curl" = "0" ]; then
  log "curl not found - cannot probe"
  echo "tried=0"
  echo "ok=0"
  echo "error=no-curl"
  exit 1
fi

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
: > "$TMPD/work"
run_pool

# Rank: TLS-complete first, then by connect time; keep one winner per host.
if [ -s "$TMPD/work" ]; then
  sort -k4,4nr -k1,1n "$TMPD/work" \
    | awk '!seen[$2]++ {print $3"\t"$2}' > "$TMPD/best"
else
  : > "$TMPD/best"
fi

{
  echo "# probed $(date '+%Y-%m-%d %H:%M:%S') timeout=${TIMEOUT}s threads=$THREADS"
  echo "# format: IP<TAB>host  (fastest reachable candidate measured on this device)"
  if [ -s "$TMPD/best" ]; then
    cat "$TMPD/best"
  else
    echo "# (no reachable candidate IP)"
  fi
} > "$OUT"

# `grep -c` exits 1 when it counts zero, and `|| echo 0` then printed a second
# line: the output was "0\n0", and the page's line-anchored parse of ok= saw a
# stray "0". Assign the count, then clamp it.
ok=$(grep -c '^[0-9]' "$OUT" 2>/dev/null)
[ -n "$ok" ] || ok=0
tried=$(wc -l < "$TMPD/queue" 2>/dev/null | tr -d ' ')
[ -n "$tried" ] || tried=0
log "resolved $ok host(s) of $tried candidate(s)"
echo "tried=$tried"
echo "ok=$ok"
if [ "$PRINT" = "1" ]; then
  echo "--- best ---"
  sed -n 's/^\([0-9.]*\)\t\(.*\)/\2 \1/p' "$OUT"
fi
rm -rf "$TMPD" 2>/dev/null
exit 0