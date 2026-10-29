#!/system/bin/sh
# Build the merged hosts file and bind-mount it. No network here: boot must
# never block on downloads (post-fs-data has a hard 10s budget).
MODDIR=${0%/*}
LOG="$MODDIR/mount.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
: > "$LOG"

i=0
while [ ! -x "$MODDIR/manager.sh" ] && [ $i -lt 50 ]; do
  sleep 0.1
  i=$((i + 1))
done
[ -x "$MODDIR/manager.sh" ] || { log "manager.sh missing/not executable"; exit 0; }

sh "$MODDIR/manager.sh" build >>"$LOG" 2>&1

# Inject the configured country code before zygote starts.
CC=$(sed -n 's/^CC=//p' "$MODDIR/config" 2>/dev/null | tail -1 | tr -d '\r' | tr 'a-z' 'A-Z')
if [ ${#CC} -eq 2 ] && command -v resetprop >/dev/null 2>&1; then
  resetprop -n ro.boot.wificountrycode "$CC" 2>/dev/null || true
  resetprop -n ro.product.wifi.country "$CC" 2>/dev/null || true
  log "cc props set to $CC"
fi
sh "$MODDIR/manager.sh" remount >>"$LOG" 2>&1

if grep -q "mtalk.google.com" /system/etc/hosts 2>/dev/null; then
  log "verify: OK"
else
  log "verify: FAILED"
fi
exit 0
