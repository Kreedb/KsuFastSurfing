#!/system/bin/sh
# One-shot data collection for the WebUI.
#
# Why this exists: the page used to call one shell per data source, so a single
# refresh was 8-11 round trips through the WebUI bridge, each with its own su
# fork, and nothing was drawn until the last one returned. Everything needed for
# one render is gathered here and printed once, in sections:
#
#   ##scan   cmd wifi list-scan-results
#   ##link   cmd wifi status
#   ##route  ip route
#   ##ping   gateway ping (only when there is a gateway)
#   ##dns    reachability of a public name
#   ##mac    wpa_supplicant's scan_results (only when the framework redacted)
#
# Nothing here waits on a fixed clock. The only pause is a bounded backoff
# (0.2/0.4/0.8 s) while asking the supplicant for results, and it is only paid
# when the framework actually returned a redacted BSSID.
#
# Usage: collect.sh          full collection
#        collect.sh scan     scan section only (used while waiting for a rescan)

case "$0" in */*) MODDIR=${0%/*} ;; *) MODDIR=. ;; esac
PATH=/data/adb/ksu/bin:/system/bin:/system/xbin:$PATH

SCAN_ONLY=0
[ "$1" = "scan" ] && SCAN_ONLY=1

scan=$(cmd wifi list-scan-results 2>&1)
printf '##scan\n%s\n' "$scan"
[ "$SCAN_ONLY" = "1" ] && exit 0

printf '##link\n%s\n' "$(cmd wifi status 2>&1)"

route=$(ip route 2>&1)
printf '##route\n%s\n' "$route"
gw=$(printf '%s\n' "$route" | sed -n 's/^default via \([0-9.]*\).*/\1/p' | head -1)
ifc=$(printf '%s\n' "$route" | sed -n 's/^default .* dev \([^ ]*\).*/\1/p' | head -1)
[ -n "$ifc" ] || ifc=wlan0

# Three packets, not five: a gateway that answers answers on the first one, and
# a gateway that does not must not cost five seconds of the user's time.
printf '##ping\n'
if [ -n "$gw" ]; then
  ping -c 3 -i 0.2 -W 1 "$gw" 2>&1
fi

printf '##dns\n'
ping -c 1 -W 1 github.com >/dev/null 2>&1
printf 'rc=%s\n' "$?"

# MAC recovery is only worth any work when the framework redacted something.
# Android 12+ hands out 68:19:**:**:37:c3 unless the caller holds location
# access; wpa_supplicant keeps the real addresses and this runs as root.
printf '##mac\n'
case "$scan" in
  *'**'*)
    sock=""
    for d in /data/vendor/wifi/wpa/sockets /data/misc/wifi/sockets /data/vendor/wifi/sockets; do
      [ -e "$d/$ifc" ] && { sock=$d; break; }
    done

    mac_read() {
      if [ -n "$sock" ]; then
        wpa_cli -p "$sock" -i "$ifc" scan_results 2>/dev/null
      else
        wpa_cli -i "$ifc" scan_results 2>/dev/null
      fi
    }

    mac=$(mac_read)
    printf '%s\n' "$mac" | grep -q '^[0-9a-f][0-9a-f]:' || {
      if [ -n "$sock" ]; then
        wpa_cli -p "$sock" -i "$ifc" scan >/dev/null 2>&1
      else
        wpa_cli -i "$ifc" scan >/dev/null 2>&1
      fi
      # 0.2 + 0.4 + 0.8 = 1.4 s worst case, and it stops at the first answer.
      # The old version slept 2 s twice, inside a loop over three socket dirs,
      # which cost 8 s on every refresh even when wpa_cli did not exist.
      for d in 0.2 0.4 0.8; do
        sleep "$d"
        mac=$(mac_read)
        printf '%s\n' "$mac" | grep -q '^[0-9a-f][0-9a-f]:' && break
      done
    }
    printf '%s\n' "$mac"
    ;;
esac
