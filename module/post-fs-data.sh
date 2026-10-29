#!/system/bin/sh
# Build the merged hosts file and bind-mount it. No network here: boot must
# never block on downloads (post-fs-data has a hard 10s budget).
MODDIR=${0%/*}
LOG="$MODDIR/mount.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
: > "$LOG"

# The module is unpacked before post-fs-data runs and customize.sh already set
# 0755, so waiting for the file to become executable could only ever burn the
# 10 s boot budget. Check once, log once, move on.
[ -x "$MODDIR/manager.sh" ] || { log "manager.sh missing/not executable"; exit 0; }

sh "$MODDIR/manager.sh" build >>"$LOG" 2>&1

# Inject the configured country code before zygote starts.
CC=$(sed -n 's/^CC=//p' "$MODDIR/config" 2>/dev/null | tail -1 | tr -d '\r' | tr 'a-z' 'A-Z')
if [ ${#CC} -eq 2 ] && command -v resetprop >/dev/null 2>&1; then
  resetprop -n ro.boot.wificountrycode "$CC" 2>/dev/null || true
  resetprop -n ro.product.wifi.country "$CC" 2>/dev/null || true
  # Some OEM ROMs (notably Honor/Huawei MagicOS) read a dedicated prop that
  # outranks the two above; setting it is harmless elsewhere.
  resetprop -n persist.sys.wifi.countrycode "$CC" 2>/dev/null || true
  resetprop -n ro.wifi.country_code "$CC" 2>/dev/null || true
  log "cc props set to $CC"
fi
# Vendor WLAN config: bind-mount a modified copy over the real /vendor file.
# The partition is never written to, so a reboot (or unmount) fully reverts it.
VENDOR_CFG=/vendor/etc/wifi/WCNSS_qcom_cfg.ini
STAGE="$MODDIR/vendorcfg/WCNSS_qcom_cfg.ini"
if [ ${#CC} -eq 2 ] && [ -f "$VENDOR_CFG" ]; then
  mkdir -p "$MODDIR/vendorcfg" 2>/dev/null
  cp -f "$VENDOR_CFG" "$STAGE" 2>/dev/null
  if [ -s "$STAGE" ]; then
    if grep -qiE '^[[:space:]]*gStaCountryCode' "$STAGE"; then
      sed -i "s/^\([[:space:]]*gStaCountryCode[[:space:]]*=\).*/\1$CC/" "$STAGE"
    else
      printf 'gStaCountryCode=%s\n' "$CC" >> "$STAGE"
    fi
    chmod 0644 "$STAGE"; chown 0:0 "$STAGE" 2>/dev/null
    chcon u:object_r:vendor_file:s0 "$STAGE" 2>/dev/null || \
      chcon u:object_r:vendor_configs_file:s0 "$STAGE" 2>/dev/null
    umount "$VENDOR_CFG" 2>/dev/null
    if mount -o bind "$STAGE" "$VENDOR_CFG" 2>>"$LOG"; then
      log "vendor cfg overlaid with gStaCountryCode=$CC"
    else
      log "vendor cfg overlay failed (ro partition?) - leaving it untouched"
    fi
  fi
fi

sh "$MODDIR/manager.sh" remount >>"$LOG" 2>&1

# Verify by content, not by a domain name: the merged file no longer contains any
# fixed domain once the user clears their entries, so a domain grep reported a
# false failure (and the same bug made the WebUI say "not mounted").
if [ -f "$MODDIR/hosts" ] && cmp -s "$MODDIR/hosts" /system/etc/hosts 2>/dev/null; then
  log "verify: OK (identical to module/hosts)"
elif mount 2>/dev/null | grep -q " /system/etc/hosts "; then
  log "verify: OK (bind mount present)"
else
  log "verify: FAILED ($(wc -l < "$MODDIR/hosts" 2>/dev/null) lines in module/hosts)"
fi
exit 0
