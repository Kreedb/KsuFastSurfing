#!/system/bin/sh
# Shared control plane for the module: fetch cloud hosts, merge, remount, set CC.
case "$0" in */*) MODDIR=${0%/*} ;; *) MODDIR=. ;; esac
PATH=/data/adb/ksu/bin:/system/bin:/system/xbin:$PATH
CONF="$MODDIR/config"
SRC_MTALK="$MODDIR/sources/mtalk.hosts"
SRC_GITHUB="$MODDIR/sources/github.hosts"
USER_HOSTS="$MODDIR/user-hosts"
OUT="$MODDIR/hosts"
SYS_HOSTS="$MODDIR/system/etc/hosts"
LOG="$MODDIR/manager.log"

URL_MTALK="https://gh-proxy.org/https://raw.githubusercontent.com/yangFenTuoZi/fcm-hosts/refs/heads/master/hosts"
URL_GITHUB="https://gh-proxy.org/https://raw.githubusercontent.com/maxiaof/github-hosts/refs/heads/master/hosts"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

conf_get() {
  v=$(sed -n "s/^$1=//p" "$CONF" 2>/dev/null | tail -1 | tr -d '\r')
  [ -n "$v" ] && echo "$v" || echo "$2"
}

net_fetch() {
  url="$1"; dst="$2"
  tmp="$dst.tmp.$$"
  rm -f "$tmp"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 12 --max-time 45 "$url" -o "$tmp" 2>>"$LOG"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$tmp" "$url" 2>>"$LOG"
  elif command -v busybox >/dev/null 2>&1; then
    busybox wget -q -O "$tmp" "$url" 2>>"$LOG"
  else
    log "no downloader available"
    return 1
  fi
  [ -s "$tmp" ] || { rm -f "$tmp"; return 1; }
  # sanity: must contain at least one "IP domain" pair
  if ! awk '/^[ \t]*#/ {next} /^[ \t]*$/ {next}
            ($1 ~ /^([0-9]{1,3}\.){3}[0-9]{1,3}$/ || $1 ~ /^[0-9A-Fa-f:]+$/) && NF >= 2 { found=1 } END { exit !found }' "$tmp"; then
    log "reject invalid payload: $url"
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$dst" || { rm -f "$tmp"; return 1; }
  log "fetched $url"
  return 0
}

emit_section() {
  f="$1"; title="$2"
  [ -s "$f" ] || return 0
  awk -v seen="$SEEN" -v title="$title" '
    BEGIN {
      while ((getline l < seen) > 0) if (l != "") s[l] = 1
      close(seen)
      printed = 0
    }
    /^[ \t]*#/ { next }
    /^[ \t]*$/ { next }
    {
      ip = $1
      if (ip !~ /^([0-9]{1,3}\.){3}[0-9]{1,3}$/ && ip !~ /^[0-9A-Fa-f:]+$/ ) next
      for (i = 2; i <= NF; i++) {
        d = $i
        if (d ~ /^#/) break
        if (d in s) continue
        if (!printed) { printf "\n# --- %s ---\n", title; printed = 1 }
        printf "%s\t%s\n", ip, d
        printf "%s\n", d >> seen
        s[d] = 1
      }
    }
  ' "$f"
}

cmd_build() {
  SEEN=$(mktemp 2>/dev/null || echo "$MODDIR/.seen.$$")
  TMP=$(mktemp 2>/dev/null || echo "$MODDIR/.hosts.$$")
  : > "$SEEN"

  # Reserve user-declared domains first so manual entries always win,
  # then drop duplicates from the cloud layers.
  if [ -s "$USER_HOSTS" ]; then
    awk '/^[ \t]*#/ {next} /^[ \t]*$/ {next}
         ($1 ~ /^([0-9]{1,3}\.){3}[0-9]{1,3}$/ || $1 ~ /^[0-9A-Fa-f:]+$/) {
           for (i = 2; i <= NF; i++) { if ($i ~ /^#/) break; print $i }
         }' "$USER_HOSTS" >> "$SEEN"
  fi

  {
    echo "# Generated $(date '+%Y-%m-%d %H:%M:%S') by KsuFastSurfing"
    echo "# layers: user-hosts > github > mtalk"
    echo
    echo "127.0.0.1\tlocalhost"
    echo "::1\tlocalhost ip6-localhost ip6-loopback"
    if [ "$(conf_get USE_GITHUB 1)" = "1" ]; then
      emit_section "$SRC_GITHUB" "GitHub accelerated (maxiaof/github-hosts)"
    fi
    if [ "$(conf_get USE_MTALK 1)" = "1" ]; then
      emit_section "$SRC_MTALK" "mtalk / FCM accelerated (yangFenTuoZi/fcm-hosts)"
    fi
    if [ -s "$USER_HOSTS" ]; then
      : > "$SEEN.user"
      SEEN="$SEEN.user" emit_section "$USER_HOSTS" "user manual entries"
    fi
  } > "$TMP"
  chmod 0644 "$TMP" 2>/dev/null
  chown 0:0 "$TMP" 2>/dev/null
  chcon u:object_r:system_file:s0 "$TMP" 2>/dev/null
  mv "$TMP" "$OUT"
  cp "$OUT" "$SYS_HOSTS" 2>/dev/null
  rm -f "$SEEN" "$SEEN.user"
  log "built hosts: $(grep -c -v '^#' "$OUT" 2>/dev/null || echo 0) lines"
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

cmd_apply_cc() {
  cc=$(conf_get CC US)
  cc=$(echo "$cc" | tr 'a-z' 'A-Z' | tr -cd 'A-Z')
  if [ ${#cc} -ne 2 ]; then
    log "invalid CC '$(conf_get CC US)', skip"
    echo "cc=SKIP invalid"
    return 1
  fi
  n=0
  while [ $n -lt 5 ]; do
    out=$(cmd wifi force-country-code enabled "$cc" 2>&1)
    case "$out" in
      *rror*|*xception*|*"not found"*|*nknown*|*ailed*)
        ;;
      *) log "cc set to $cc"; echo "cc=$cc"; return 0 ;;
    esac
    sleep 2
    n=$((n + 1))
  done
  echo "cc=FAILED"
  return 1
}

cmd_apply_regdom() {
  # cmd wifi only tells the framework. Push the same code into cfg80211 so the
  # kernel channel table follows. Both are best-effort: on most phones the
  # vendor WLAN driver keeps its own domain and ignores this.
  cc=$(conf_get CC US)
  cc=$(echo "$cc" | tr 'a-z' 'A-Z' | tr -cd 'A-Z')
  [ ${#cc} -eq 2 ] || { echo "regdom=skipped"; return 1; }
  got=""

  if command -v iw >/dev/null 2>&1; then
    dev=$(iw dev 2>/dev/null | awk '/Interface/{print $2; exit}')
    if [ -n "$dev" ]; then
      # iw reg set writes the global domain via nl80211
      iw reg set "$cc" 2>>"$LOG" && got=iw
    fi
    iw reg get 2>/dev/null | grep -q "country $cc" && got="${got:-iw}"
  fi

  # Legacy interface, still honoured by some vendor drivers.
  if command -v iwconfig >/dev/null 2>&1 && [ -z "$got" ]; then
    dev=$(iw dev 2>/dev/null | awk '/Interface/{print $2; exit}')
    [ -n "$dev" ] && iwconfig "$dev" reg "$cc" 2>>"$LOG" && got=iwconfig
  fi

  log "regdom set to $cc via ${got:-nothing}"
  echo "regdom=${got:-failed}"
  [ -n "$got" ]
}

cmd_status() {
  H=/system/etc/hosts
  if [ -f "$OUT" ]; then
    m=$(awk '/^# --- mtalk/{f=1;next} /^# --- /{f=0} f && /^[0-9]/ {c++} END{print c+0}' "$OUT")
    g=$(awk '/^# --- GitHub/{f=1;next} /^# --- /{f=0} f && /^[0-9]/ {c++} END{print c+0}' "$OUT")
    u=$(awk '/^# --- user/{f=1;next} /^# --- /{f=0} f && /^[0-9]/ {c++} END{print c+0}' "$OUT")
  else
    m=0; g=0; u=0
  fi
  printf 'mtalk=%s\n' "$m"
  printf 'github=%s\n' "$g"
  printf 'user=%s\n' "$u"
  printf 'mounted=%s\n' "$(grep -q 'mtalk\.google\.com\|github\.com' "$H" 2>/dev/null && echo 1 || echo 0)"
  printf 'cc=%s\n' "$(conf_get CC US)"
  printf 'cur_cc=%s\n' "$(cmd wifi status 2>/dev/null | grep -i 'country code' | head -1 | sed 's/.*: *//' | tr -d '\r')"
  printf 'use_mtalk=%s\n' "$(conf_get USE_MTALK 1)"
  printf 'use_github=%s\n' "$(conf_get USE_GITHUB 1)"
}

case "$1" in
  build)     cmd_build ;;
  remount)   cmd_remount ;;
  refresh)
    rc=0
    [ "$(conf_get USE_MTALK 1)" = "1" ]  && { net_fetch "$URL_MTALK" "$SRC_MTALK"   || rc=1; }
    [ "$(conf_get USE_GITHUB 1)" = "1" ] && { net_fetch "$URL_GITHUB" "$SRC_GITHUB" || rc=1; }
    cmd_build
    cmd_remount
    cmd_apply_cc >/dev/null 2>&1
    cmd_apply_regdom >/dev/null 2>&1 || true
    echo "refresh_rc=$rc"
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
  cc-check)
    # Compact key=value summary for the WebUI. No `iw` dependency: retail
    # Android images usually do not ship it, so we read what the framework
    # and the scan cache expose instead.
    cur=$(dumpsys wifi 2>/dev/null | grep -i '^Current Country Code:' | head -1 | sed 's/.*: *//' | tr -d '\r')
    printf 'framework=%s\n' "${cur:-unknown}"
    sup=""
    for f in /data/misc/apexdata/com.android.wifi/WifiSupplicantControl/wpa_supplicant.conf \
             /data/misc/wifi/wpa_supplicant.conf; do
      [ -r "$f" ] || continue
      sup=$(grep -iE '^[[:space:]]*country=' "$f" 2>/dev/null | head -1 | sed 's/.*=//' | tr -d '\r')
      break
    done
    printf 'supplicant=%s\n' "${sup:-unset}"
    sr=$(cmd wifi list-scan-results 2>&1)
    printf 'bss5g=%s\n' "$(echo "$sr" | awk 'NR>1 && $2+0>=4900 && $2+0<=5895 {c++} END{print c+0}')"
    printf 'unii2c=%s\n' "$(echo "$sr" | awk 'NR>1 && $2+0>=5470 && $2+0<=5725 {c++} END{print c+0}')"
    printf 'unii3=%s\n' "$(echo "$sr" | awk 'NR>1 && $2+0>5725 && $2+0<=5895 {c++} END{print c+0}')"
    printf 'config=%s\n' "$(conf_get CC US)"
    ;;
  *) echo "usage: manager.sh {refresh|apply|status|set-cc XX|regdom|diagnose|cc-check|build|remount}"; exit 2 ;;
esac
