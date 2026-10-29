#!/system/bin/sh
# After boot: refresh hosts from the cloud (non-blocking) and apply the
# configured Wi-Fi country code.
MODDIR=${0%/*}
LOG="$MODDIR/service.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
: > "$LOG"

n=0
while [ "$(getprop sys.boot_completed)" != "1" ] && [ $n -lt 180 ]; do
  sleep 1
  n=$((n + 1))
done

out=$(sh "$MODDIR/manager.sh" refresh 2>&1)
log "refresh: $out"

exit 0
