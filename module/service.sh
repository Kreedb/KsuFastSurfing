#!/system/bin/sh
# After boot: probe IPs, rebuild hosts, apply the country code.
# Non-blocking: this runs in the late_start service stage, so a slow network
# here never delays boot. post-fs-data stays strictly offline.
MODDIR=${0%/*}
LOG="$MODDIR/service.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
: > "$LOG"

n=0
while [ "$(getprop sys.boot_completed)" != "1" ] && [ $n -lt 180 ]; do
  sleep 1
  n=$((n + 1))
done

# Give the radio a moment to associate before measuring latency.
sleep 5
out=$(sh "$MODDIR/manager.sh" refresh 2>&1)
log "refresh: $out"

exit 0
