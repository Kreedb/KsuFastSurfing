#!/system/bin/sh
# Control plane for the module. Everything here is driven by local files:
# probe.sh measures which IPs actually answer on this device's network,
# user-hosts holds manual entries, and hosts is the merged result.
case "$0" in */*) MODDIR=${0%/*} ;; *) MODDIR=. ;; esac
PATH=/data/adb/ksu/bin:/system/bin:/system/xbin:$PATH

CONF="$MODDIR/config"
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
# One source: user-hosts. Detection results reach this file only because the
# page put them in the user's editor and the user pressed save, so there is no
# second layer to merge, no USE_PROBED switch, and no way for a background run
# to change what is mounted.

cmd_build() {
  TMP=$(mktemp 2>/dev/null || echo "$MODDIR/.hosts.$$")

  {
    echo "# Generated $(date '+%Y-%m-%d %H:%M:%S') by KsuFastSurfing"
    echo "# source: user-hosts (every entry was chosen by the user)"
    echo
    echo "127.0.0.1	localhost"
    echo "::1	localhost ip6-localhost ip6-loopback"

    if [ -s "$USER_HOSTS" ]; then
      # The header is printed by the first entry, not up front, so an all-comment
      # file does not produce an empty section. seen[] is what stops a hostname
      # appearing twice - the previous version wrote the set but never read it,
      # so two lines for one name both survived.
      awk '
        /^[ \t]*#/ { next }
        /^[ \t]*$/ { next }
        {
          if ($1 !~ /^([0-9]{1,3}\.){3}[0-9]{1,3}$/ && $1 !~ /^[0-9A-Fa-f:]+$/) next
          ip = $1
          for (i = 2; i <= NF; i++) {
            if ($i ~ /^#/) break
            if ($i in seen) next
            seen[$i] = 1
            if (!p) { print ""; print "# --- user entries ---"; p = 1 }
            print ip "\t" $i
          }
        }' "$USER_HOSTS"
    fi
  } > "$TMP"

  chmod 0644 "$TMP" 2>/dev/null
  chown 0:0 "$TMP" 2>/dev/null
  chcon u:object_r:system_file:s0 "$TMP" 2>/dev/null
  mv "$TMP" "$OUT"
  [ -f "$SYS_HOSTS" ] && cp "$OUT" "$SYS_HOSTS" 2>/dev/null
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
  # Retries back off (0.3/0.6/1.2 s) and stop at the first success. The old
  # version slept a flat 2 s five times, so a rejected code cost 10 s before
  # the user saw the same failure.
  for d in 0.3 0.6 1.2; do
    out=$(cmd wifi force-country-code enabled "$cc" 2>&1)
    case "$out" in
      *rror*|*xception*|*"not found"*|*nknown*|*ailed*) sleep "$d" ;;
      *) log "cc set to $cc"; echo "cc=$cc"; return 0 ;;
    esac
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
  u=0
  [ -s "$USER_HOSTS" ] && u=$(grep -vcE '^[ \t]*(#|$)' "$USER_HOSTS" 2>/dev/null)

  # user counts the lines the editor holds; entries counts what survived the
  # merge (loopback and comments excluded), so a duplicate line is visible as
  # "3 lines in, 2 in effect" instead of silently disappearing.
  printf 'user=%s\n' "${u:-0}"
  printf 'entries=%s\n' "$(awk '!($1 == "127.0.0.1" || $1 == "::1") && !/^[ \t]*(#|$)/' "$OUT" 2>/dev/null | grep -c .)"

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
  printf 'timeout=%s\n' "$(conf_get PROBE_TIMEOUT 3)"
  printf 'threads=%s\n' "$(conf_get PROBE_THREADS 8)"
}

case "$1" in
  build)     cmd_build ;;
  remount)   cmd_remount ;;
  # `apply` is the only path that changes what is mounted. There is no
  # probe/refresh shortcut any more: detection is a read-only tool the user
  # runs from the page, and its output only becomes state when the user saves.
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
  # Two read-only reports, and nothing else: `diagnose` walks the four layers
  # that decide which channels exist, `capacity` asks the driver what it can do.
  # Per-AP analysis lives in the WebUI (webroot/diag.js); `cc-check` was a third
  # copy of the same channel bucketing and is gone with it.
  diagnose)  sh "$MODDIR/diagnose.sh" ;;
  # Hardware capability report: what this radio can and cannot do, so a feature
  # request can be answered with the device's own answer instead of a guess.
  capacity)  sh "$MODDIR/capacity.sh" ${2:+--json} ;;
  *) echo "usage: manager.sh {apply|status|set-cc XX|diagnose|capacity|build|remount}"; exit 2 ;;
esac
