#!/system/bin/sh
# Boot hook. The page builds hosts and mounts it while the UI is open; at boot
# there is no WebView, so this hook re-applies the one thing that must survive a
# reboot: the hosts file.
#
# The country code is deliberately not touched here. `cmd wifi
# force-country-code` is runtime state owned by the framework; it lasts until
# reboot and is re-applied from the UI in one tap. Injecting properties here as
# well meant two sources of truth for one setting, and the property path could
# not be verified from the page.
#
# No network, no probing, no collection: post-fs-data has a 10 s budget.
# There is no service.sh and no manager.sh. Everything that measures or changes
# state runs from the WebUI, where the user can see the command and its output.

MODDIR=${0%/*}
LOG="$MODDIR/mount.log"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
: > "$LOG"

H="$MODDIR/hosts"
if [ ! -s "$H" ]; then
  log "no hosts yet (the WebUI writes one on first save)"
  exit 0
fi

# Nothing else to restore. The vendor WLAN config overlay that used to live
# here edited gStaCountryCode in a copy of /vendor/etc/wifi/WCNSS_qcom_cfg.ini;
# it only ever mattered on one chip family, took effect a boot later than the
# framework API, and made "what country is this radio in" unanswerable. The
# runtime call reports its own result, so there is nothing to pre-seed.

# Mount the file the page wrote. /etc/hosts is usually a symlink to
# /system/etc/hosts, so the same inode is mounted once.
chmod 0644 "$H" 2>/dev/null
chown 0:0 "$H" 2>/dev/null
chcon u:object_r:system_file:s0 "$H" 2>/dev/null

TARGETS=""
for t in /system/etc/hosts /etc/hosts; do
  [ -e "$t" ] || continue
  real=$(readlink -f "$t" 2>/dev/null)
  [ -n "$real" ] || real="$t"
  dup=0
  for seen in $TARGETS; do
    [ "$seen" = "$real" ] && dup=1
  done
  [ "$dup" = 1 ] && continue
  TARGETS="$TARGETS $real"
done

for t in $TARGETS; do
  umount "$t" 2>/dev/null
  if mount -o bind "$H" "$t" 2>>"$LOG"; then
    log "mounted $H -> $t"
  else
    log "mount failed: $t"
  fi
done

# Verify by content, not by a domain name: the merged file contains no fixed
# domain once the user clears their entries, so a domain grep would report a
# false failure.
if cmp -s "$H" /system/etc/hosts 2>/dev/null; then
  log "verify: OK (identical to module/hosts)"
elif mount 2>/dev/null | grep -q " /system/etc/hosts "; then
  log "verify: OK (bind mount present)"
else
  log "verify: FAILED ($(wc -l < "$H" 2>/dev/null) lines in module/hosts)"
fi
exit 0
