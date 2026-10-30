#!/system/bin/sh
# Boot hook. The page builds hosts and mounts it while the UI is open; at boot
# there is no WebView, so this hook can only re-apply what the page saved:
#   - inject the configured country-code properties
#   - overlay the vendor WLAN config when that file exists
#   - bind-mount module/hosts over the system copies
# No network, no probing, no collection: post-fs-data has a 10 s budget.
#
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
