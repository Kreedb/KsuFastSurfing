#!/system/bin/sh
# Control plane for the module. Everything here is driven by local files:
# probe.sh measures which IPs actually answer on this device's network,
# user-hosts holds manual entries, and hosts is the merged result.
case "$0" in */*) MODDIR=${0%/*} ;; *) MODDIR=. ;; esac
PATH=/data/adb/ksu/bin:/system/bin:/system/xbin:$PATH

CONF="$MODDIR/config"
PROBED="$MODDIR/probed-hosts"
USER_HOSTS="$MODDIR/user-hosts"
OUT="$MODDIR/hosts"
SYS_HOSTS="$MODDIR/system/etc/hosts"
LOG="$MODDIR/manager.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

conf_get() {
  v=$(sed -n "s/^$1=//p" "$CONF" 2>/dev/null | tail -1 | tr -d '\r')
  [ -n "$v" ] && echo "$v" || echo "$2"
}

# ---------- merged hosts ----------

cmd_build() {
  SEEN=$(mktemp 2>/dev/null || echo "$MODDIR/.seen.$$")
  TMP=$(mktemp 2>/dev/null || echo "$MODDIR/.hosts.$$")
  : > "$SEEN"

  # Reserve user-declared domains first so manual entries always win.
  if [ -s "$USER_HOSTS" ]; then
    awk '/^[ \t]*#/ {next} /^[ \t]*$/ {next}
         ($1 ~ /^([0-9]{1,3}\.){3}[0-9]{1,3}$/ || $1 ~ /^[0-9A-Fa-f:]+$/) {
           for (i = 2; i <= NF; i++) { if ($i ~ /^#/) break; print $i }
         }' "$USER_HOSTS" >> "$SEEN"
  fi

  {
    echo "# Generated $(date '+%Y-%m-%d %H:%M:%S') by KsuFastSurfing"
    echo "# layers: user-hosts > probed-hosts"
    echo
    echo "127.0.0.1	localhost"
    echo "::1	localhost ip6-localhost ip6-loopback"

    if [ -s "$PROBED" ] && [ "$(conf_get USE_PROBED 1)" = "1" ]; then
      awk -v seen="$SEEN" '
        BEGIN { while ((getline l < seen) > 0) if (l != "") s[l] = 1; close(seen); p = 0 }
        /^[ \t]*#/ { next }
        /^[ \t]*$/ { next }
        {
          # probed-hosts is "IP<TAB>host"
          ip = $1; host = $2
          if (ip !~ /^([0-9]{1,3}\.){3}[0-9]{1,3}$/) next
          if (host == "" || host in s) next
          if (!p) { print ""; print "# --- locally probed ---"; p = 1 }
          print ip "\t" host
          s[host] = 1
        }' "$PROBED"
    fi

    if [ -s "$USER_HOSTS" ]; then
      : > "$SEEN.user"
      awk -v seen="$SEEN.user" '
        BEGIN { while ((getline l < seen) > 0) if (l != "") s[l] = 1; close(seen); p = 0 }
        /^[ \t]*#/ { next }
        /^[ \t]*$/ { next }
        {
          if ($1 !~ /^([0-9]{1,3}\.){3}[0-9]{1,3}$/ && $1 !~ /^[0-9A-Fa-f:]+$/) next
          ip = $1
          for (i = 2; i <= NF; i++) {
            if ($i ~ /^#/) break
            if (!p) { print ""; print "# --- user manual entries ---"; p = 1 }
            print ip "\t" $i
            s[$i] = 1
          }
        }' "$USER_HOSTS"
    fi
  } > "$TMP"

  chmod 0644 "$TMP" 2>/dev/null
  chown 0:0 "$TMP" 2>/dev/null
  chcon u:object_r:system_file:s0 "$TMP" 2>/dev/null
  mv "$TMP" "$OUT"
  [ -f "$SYS_HOSTS" ] && cp "$OUT" "$SYS_HOSTS" 2>/dev/null
  rm -f "$SEEN" "$SEEN.user"
  log "built hosts: $(grep -c '^[0-9]' "$OUT" 2>/dev/null || echo 0) entries"
}

cmd_remount() {
  chmod 0644 "$OUT" 2>/dev/null
  chown 0:0 "$OUT" 2>/dev/null
  chcon u:object_r:system_file:s0 "$OUT" 2>/dev/null

  TARGETS=""
  add_target() {
    [ -e "$1" ] || return 0
    real=$(readlink -f "$1" 2>/dev/null)
    [ -n "$real" ] || real="$1"
    for seen in $TARGETS; do
      [ "$seen" = "$real" ] && return 0
    done
    TARGETS="$TARGETS $real"
  }
  add_target /system/etc/hosts
  add_target /etc/hosts

  for t in $TARGETS; do
    umount "$t" 2>/dev/null
    if mount -o bind "$OUT" "$t" 2>>"$LOG"; then
      log "remounted $OUT -> $t"
    else
      log "remount failed: $t"
    fi
  done
  log "remount done"
}

# ---------- country code ----------

# One reader for every caller, so the WebUI and status agree on the value.
# `cmd wifi status` never prints it; `cmd wifi get-country-code` is the API.
cc_current() {
  v=""
  if command -v cmd >/dev/null 2>&1; then
    # Output wording differs across OEMs ("Country code is: US", "Wifi Country
    # Code: US", ...), so take the last two-letter uppercase token instead of
    # trusting a prefix. Passing the whole line through to the UI showed up as
    # "国家码（当前）COUNTRY CODE IS: US".
    v=$(cmd wifi get-country-code 2>/dev/null | tr -d '\r' | tr 'a-z' 'A-Z' \
        | grep -o '[A-Z][A-Z]' | tail -1)
    [ -n "$v" ] && { echo "$v"; return 0; }
  fi
  if command -v dumpsys >/dev/null 2>&1; then
    v=$(dumpsys wifi 2>/dev/null | sed -n 's/^Current Country Code: *//p' | head -1 | tr -d '\r' \
        | tr 'a-z' 'A-Z' | tr -cd 'A-Z' )
    [ ${#v} -eq 2 ] && { echo "$v"; return 0; }
  fi
  echo ""
}

cmd_apply_cc() {
  cc=$(conf_get CC US)
  cc=$(echo "$cc" | tr 'a-z' 'A-Z' | tr -cd 'A-Z')
  if [ ${#cc} -ne 2 ]; then
    echo "cc=SKIP invalid"
    return 1
  fi
  n=0
  while [ $n -lt 5 ]; do
    out=$(cmd wifi force-country-code enabled "$cc" 2>&1)
    case "$out" in
      *rror*|*xception*|*"not found"*|*nknown*|*ailed*) ;;
      *) log "cc set to $cc"; echo "cc=$cc"; return 0 ;;
    esac
    sleep 2
    n=$((n + 1))
  done
  echo "cc=FAILED"
  return 1
}

cmd_apply_regdom() {
  cc=$(conf_get CC US)
  cc=$(echo "$cc" | tr 'a-z' 'A-Z' | tr -cd 'A-Z')
  [ ${#cc} -eq 2 ] || { echo "regdom=skipped"; return 1; }
  got=""
  if command -v iw >/dev/null 2>&1; then
    iw reg set "$cc" 2>>"$LOG" && got=iw
  fi
  log "regdom set to $cc via ${got:-nothing}"
  echo "regdom=${got:-failed}"
  [ -n "$got" ]
}

# ---------- status ----------

cmd_status() {
  H=/system/etc/hosts
  p=0; u=0
  [ -s "$PROBED" ] && p=$(grep -c '^[0-9]' "$PROBED" 2>/dev/null)
  [ -s "$USER_HOSTS" ] && u=$(grep -vcE '^[ \t]*(#|$)' "$USER_HOSTS" 2>/dev/null)

  printf 'probed=%s\n' "${p:-0}"
  printf 'user=%s\n' "${u:-0}"
  printf 'entries=%s\n' "$(grep -c '^[0-9]' "$OUT" 2>/dev/null || echo 0)"

  # Real mount check: compare the live file with the one we generated. The old
  # check looked for a domain that no longer exists and always said "unmounted".
  if [ -f "$OUT" ] && [ -f "$H" ] && cmp -s "$OUT" "$H" 2>/dev/null; then
    printf 'mounted=1\n'
  elif [ -f "$H" ] && mount 2>/dev/null | grep -q " $H "; then
    printf 'mounted=1\n'
  else
    printf 'mounted=0\n'
  fi

  want=$(conf_get CC US | tr 'a-z' 'A-Z')
  cur=$(cc_current)
  printf 'cc=%s\n' "$want"
  printf 'cur_cc=%s\n' "$cur"
  printf 'use_probed=%s\n' "$(conf_get USE_PROBED 1)"
  printf 'timeout=%s\n' "$(conf_get PROBE_TIMEOUT 3)"
  printf 'threads=%s\n' "$(conf_get PROBE_THREADS 8)"
}

case "$1" in
  build)     cmd_build ;;
  remount)   cmd_remount ;;
  probe)
    sh "$MODDIR/probe.sh" ${2:+--print}
    cmd_build
    cmd_remount
    ;;
  refresh)
    sh "$MODDIR/probe.sh" >/dev/null 2>&1
    cmd_build
    cmd_remount
    cmd_apply_cc >/dev/null 2>&1
    ;;
  apply)
    cmd_build
    cmd_remount
    ;;
  set-cc)
    [ -n "$2" ] || { echo "usage: manager.sh set-cc XX"; exit 2; }
    v=$(echo "$2" | tr 'a-z' 'A-Z' | tr -cd 'A-Z')
    [ ${#v} -eq 2 ] || { echo "error=invalid code"; exit 2; }
    if grep -q '^CC=' "$CONF" 2>/dev/null; then
      sed -i "s/^CC=.*/CC=$v/" "$CONF"
    else
      echo "CC=$v" >> "$CONF"
    fi
    printf 'ro.boot.wificountrycode=%s\nro.product.wifi.country=%s\n' "$v" "$v" > "$MODDIR/system.prop" 2>/dev/null
    if command -v resetprop >/dev/null 2>&1; then
      resetprop -n ro.boot.wificountrycode "$v" 2>/dev/null || true
      resetprop -n ro.product.wifi.country "$v" 2>/dev/null || true
    fi
    cmd_apply_cc
    cmd_apply_regdom >/dev/null 2>&1 || true
    ;;
  status)    cmd_status ;;
  regdom)    cmd_apply_regdom ;;
  diagnose)  sh "$MODDIR/diagnose.sh" ;;
  wifi)      sh "$MODDIR/wifidiag.sh" ${2:-scan} ;;
  wifi-api)  sh "$MODDIR/wifidiag.sh" api ;;
  cc-check)
    printf 'framework=%s\n' "$(cc_current)"
    sr=$(cmd wifi list-scan-results 2>&1)
    # Bucket by channel number, not by frequency range: 5725 MHz is the UNII-2C/
    # UNII-3 fence, so a frequency test classifies ch149 wrongly.
    echo "$sr" | awk '
      NR > 1 && $2 + 0 >= 2400 {
        f = $2 + 0
        if (f <= 2500) next                      # 2.4G is not interesting here
        if (f <= 5895) c = int((f - 5000) / 5); else c = int((f - 5950) / 5)
        n++
        if (c >= 52 && c <= 64)                dfs++
        if (c >= 100 && c <= 144)              { dfs++; u2c++ }
        if (c >= 149)                          u3++
      }
      END {
        printf "bss5g=%d\n", n + 0
        printf "unii2c=%d\n", u2c + 0
        printf "unii3=%d\n", u3 + 0
        printf "dfs_total=%d\n", dfs + 0
      }'
    printf 'config=%s\n' "$(conf_get CC US)"
    printf 'kernel=%s\n' "$( [ -r /sys/module/cfg80211/parameters/ieee80211_regdom ] && cat /sys/module/cfg80211/parameters/ieee80211_regdom || echo unknown )"
    ;;
  *) echo "usage: manager.sh {probe|refresh|apply|status|set-cc XX|regdom|wifi|wifi-api|diagnose|cc-check|build|remount}"; exit 2 ;;
esac
