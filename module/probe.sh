#!/system/bin/sh
# Measure which candidate IP answers fastest for each domain, on this device.
#
# This script is read-only: it prints "IP<TAB>host" for the winner of each host
# on stdout and writes the play-by-play to probe.log. It never edits hosts,
# never applies anything, and never runs on its own - the WebUI calls it when
# the user presses the button, and the user decides what to keep.
#
# The log exists because a probe takes tens of seconds and a spinner alone says
# nothing about whether it is resolving, connecting or failing. The page tails
# this file while the command runs.
#
# Resolution is a chain that stops at the first answer, and each step has a
# hard cap. The old version ran ping, getent, nslookup and both DoH endpoints
# unconditionally, so every host cost 5-7 s even when the first lookup already
# had the address.

case "$0" in */*) MODDIR=${0%/*} ;; *) MODDIR=. ;; esac
PATH=/data/adb/ksu/bin:/system/bin:/system/xbin:$PATH

CONF="$MODDIR/config"
LOG="$MODDIR/probe.log"
DOMAINS="$MODDIR/domains"
TMPD="$MODDIR/.probe"

conf_get() {
  v=$(sed -n "s/^$1=//p" "$CONF" 2>/dev/null | tail -1 | tr -d '\r')
  [ -n "$v" ] && echo "$v" || echo "$2"
}

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >> "$LOG"; }

TIMEOUT=$(conf_get PROBE_TIMEOUT 3)
THREADS=$(conf_get PROBE_THREADS 8)
case "$TIMEOUT" in ''|*[!0-9]*) TIMEOUT=3 ;; esac
case "$THREADS" in ''|*[!0-9]*|0) THREADS=8 ;; esac
[ "$TIMEOUT" -lt 1 ] && TIMEOUT=1
[ "$TIMEOUT" -gt 10 ] && TIMEOUT=10
[ "$THREADS" -gt 16 ] && THREADS=16

mkdir -p "$TMPD" 2>/dev/null
rm -f "$TMPD"/* 2>/dev/null
: > "$LOG"
start=$(date +%s)

LIST=$(grep -vE '^[[:space:]]*(#|$)' "$DOMAINS" 2>/dev/null)
if [ -z "$LIST" ]; then
  log "no domains in $DOMAINS"
  log "done hosts=0 candidates=0"
  exit 1
fi
dom=$(printf '%s\n' "$LIST" | grep -c .)
log "start domains=$dom timeout=${TIMEOUT}s threads=$THREADS"

have_curl=1
command -v curl >/dev/null 2>&1 || {
  have_curl=0
  log "curl missing - cannot measure"
}

# One A record from a DoH JSON answer, capped at 2 s. type 1 is A; a CNAME
# carries a name in "data" instead, so the field is filtered by shape too.
doh_ips() {
  curl -sS -k --max-time 2 -H 'accept: application/dns-json' "$1" 2>/dev/null \
    | tr '{' '\n' \
    | grep -E '"type"[[:space:]]*:[[:space:]]*1[,}]' \
    | sed -n 's/.*"data"[[:space:]]*:[[:space:]]*"\([0-9][0-9.]*\)".*/\1/p'
}

# Resolve one name. Stops at the first source that produces an address: the
# system resolver is absent on retail ROMs, toybox ping is always there, and
# DoH is the fallback rather than a fixed cost on every host.
resolve() {
  h=$1
  ips=""

  a=$(ping -c 1 -W 1 "$h" 2>/dev/null \
      | sed -n 's/^PING [^(]*(\([0-9][0-9.]*\)).*/\1/p' | head -1)
  [ -n "$a" ] && ips="$ips $a"

  if command -v getent >/dev/null 2>&1; then
    a=$(getent hosts "$h" 2>/dev/null | awk '{print $1}' | head -3)
    [ -n "$a" ] && ips="$ips $a"
  fi
  if command -v nslookup >/dev/null 2>&1; then
    a=$(nslookup "$h" 2>/dev/null \
        | sed -n 's/^Address[^:]*:[[:space:]]*\([0-9][0-9.]*\)$/\1/p' | head -3)
    [ -n "$a" ] && ips="$ips $a"
  fi

  if [ -z "$ips" ]; then
    a=$(doh_ips "https://cloudflare-dns.com/dns-query?name=$h&type=A")
    [ -n "$a" ] && ips="$ips $a"
  fi
  if [ -z "$ips" ]; then
    a=$(doh_ips "https://dns.google/resolve?name=$h&type=A")
    [ -n "$a" ] && ips="$ips $a"
  fi

  printf '%s\n' $ips | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u
}

# One candidate. Reachability is time_connect, not curl's exit code: a 403 or a
# failed handshake still proves the path is up. tls=1 means the handshake
# completed, which is what a hosts redirect actually needs.
probe_one() {
  h=$1; ip=$2
  w=$(curl -sS -o /dev/null -k --connect-timeout "$TIMEOUT" --max-time "$TIMEOUT" \
        --resolve "$h:443:$ip" -w '%{time_connect} %{time_appconnect}' \
        "https://$h/" 2>/dev/null)
  if [ -z "$w" ]; then log "fail $h $ip"; return 1; fi
  set -- $w
  conn=$1; tls=$2
  case "$conn" in ''|0|0.0|0.000000) log "fail $h $ip"; return 1 ;; esac
  case "$tls" in ''|0|0.0|0.000000) tls=0 ;; *) tls=1 ;; esac
  log "ok   $h $ip ${conn}s tls=$tls"
  printf '%s %s %s %s\n' "$conn" "$h" "$ip" "$tls"
}

# --- resolve, bounded by the same thread count as the probing ---------------
: > "$TMPD/res"
i=0
for h in $LIST; do
  : > "$TMPD/res.$h"
  ( resolve "$h" > "$TMPD/res.$h" ) &
  i=$((i + 1))
  if [ $((i % THREADS)) -eq 0 ]; then wait; fi
done
wait

for f in "$TMPD"/res.*; do
  [ -f "$f" ] || continue
  h=${f##*/res.}
  if [ -s "$f" ]; then
    sort -u "$f" >> "$TMPD/queue"
    log "resolve $h -> $(grep -c . "$f") ip"
  else
    log "resolve $h -> none"
  fi
done
total=$(grep -c . "$TMPD/queue" 2>/dev/null)
[ -n "$total" ] || total=0
log "candidates=$total"

if [ "$have_curl" = "0" ] || [ "$total" = "0" ]; then
  log "done hosts=0 candidates=$total"
  exit 1
fi

# --- probe ----------------------------------------------------------------
: > "$TMPD/work"
run_pool() {
  i=0
  while read -r h ip; do
    [ -n "$h" ] || continue
    probe_one "$h" "$ip" >> "$TMPD/work" &
    i=$((i + 1))
    if [ $((i % THREADS)) -eq 0 ]; then wait; fi
  done < "$TMPD/queue"
  wait
}
run_pool

# Rank: TLS-complete first, then by connect time; one winner per host.
if [ -s "$TMPD/work" ]; then
  sort -k4,4nr -k1,1n "$TMPD/work" \
    | awk '!seen[$2]++ {print $3"\t"$2}' > "$TMPD/best"
else
  : > "$TMPD/best"
fi

cat "$TMPD/best"
ok=$(grep -c . "$TMPD/best" 2>/dev/null)
[ -n "$ok" ] || ok=0
log "done hosts=$ok candidates=$total seconds=$(( $(date +%s) - start ))"
rm -rf "$TMPD" 2>/dev/null
