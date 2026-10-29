#!/system/bin/sh
# Dump every layer that can restrict 5GHz/DFS channels, then point at the
# layer that is actually blocking. Read-only: changes nothing.
MODDIR=${0%/*}
case "$MODDIR" in */*) ;; *) MODDIR=. ;; esac
OUT="$MODDIR/diagnose.log"
CC_WANT=$(sed -n 's/^CC=//p' "$MODDIR/config" 2>/dev/null | tail -1 | tr -d '\r')
[ -n "$CC_WANT" ] || CC_WANT=US

say() { echo "$*"; echo "$*" >> "$OUT"; }
: > "$OUT"

say "=============================================="
say " KsuFastSurfing diagnose  (want CC=$CC_WANT)"
say "=============================================="

# ---------- 1. framework ----------
say ""
say "--- [1] framework (WifiService) ---"
if command -v cmd >/dev/null 2>&1; then
  st=$(cmd wifi status 2>&1)
  echo "$st" >> "$OUT"
  cc_fw=$(echo "$st" | grep -i 'country code' | head -1 | sed 's/.*: *//' | tr -d '\r')
  say "framework_cc=${cc_fw:-unknown}"
else
  say "framework_cc=cmd unavailable"
fi
say "settings_country=$(settings get global wifi_country_code 2>/dev/null)"

# ---------- 2. kernel regulatory domain ----------
say ""
say "--- [2] kernel regdb (cfg80211) ---"
if command -v iw >/dev/null 2>&1; then
  reg=$(iw reg get 2>&1)
  echo "$reg" >> "$OUT"
  # "country US:" / "country 00:" (00 = world domain, the usual culprit)
  dom=$(echo "$reg" | grep -o 'country [A-Z0-9][A-Z0-9]' | head -1 | awk '{print $2}')
  say "kernel_regdomain=${dom:-none}"
  case "$dom" in
    00|"") say "  !! world domain (00) = most DFS/UNII-2C channels marked NO-IR" ;;
  esac
else
  say "kernel_regdomain=iw unavailable"
fi

# ---------- 3. what the PHY actually allows ----------
say ""
say "--- [3] phy channel table (the ground truth) ---"
if command -v iw >/dev/null 2>&1; then
  phy=$(iw list 2>/dev/null || iw phy 2>/dev/null)
  echo "$phy" >> "$OUT"
  # Channels 100-144 live in 5470-5725 MHz.
  # Channel numbers are the definition; frequencies near 5725 belong to
  # channel 149 (UNII-3), so matching on frequency alone gives false positives.
  seg=$(echo "$phy" | awk '
    match($0, /[0-9]+ MHz \[[0-9]+\]/) {
      ch = $0
      sub(/.*\[/, "", ch); sub(/\].*/, "", ch)
      if (ch + 0 >= 100 && ch + 0 <= 144) { print; n++; if (n >= 12) exit }
    }')
  if [ -n "$seg" ]; then
    say "unii2c_channels_present=yes"
    echo "$seg" | sed 's/^[[:space:]]*//' | while read -r l; do say "  $l"; done
  else
    say "unii2c_channels_present=NO"
    say "  !! the radio never advertises channel 100-144 -> firmware/driver"
    say "     excludes UNII-2C. No country-code trick can add them back."
  fi
  passive=$(echo "$phy" | grep -c 'radar detection')
  say "channels_with_radar_flag=$passive"
else
  say "phy=iw unavailable"
fi

# ---------- 4. Qualcomm WLAN config ----------
say ""
say "--- [4] vendor (Qualcomm) WLAN config ---"
for f in /vendor/etc/wifi/WCNSS_qcom_cfg.ini \
         /vendor/etc/wifi/wifi_con_mode.conf \
         /system/etc/wifi/WCNSS_qcom_cfg.ini; do
  if [ -r "$f" ]; then
    say "found: $f"
    grep -iE 'country|regdom|11d' "$f" 2>/dev/null | sed 's/^/    /' | tee -a "$OUT"
  fi
done
[ -e /vendor/etc/wifi/WCNSS_qcom_wlan_nv.bin ] && say "nv_bin: present (DefaultCountryTable may pin the domain)"
say "wlan_ini_country=$(grep -i '^gStaCountryCode' /vendor/etc/wifi/WCNSS_qcom_cfg.ini 2>/dev/null | head -1)"

# ---------- 5. is the AP even on ch100? ----------
say ""
say "--- [5] scan: are DFS APs visible at all? ---"
if command -v iw >/dev/null 2>&1; then
  dev=$(iw dev 2>/dev/null | awk '/Interface/{print $2; exit}')
  if [ -n "$dev" ]; then
    say "iface=$dev"
    sc=$(iw dev "$dev" scan 2>/dev/null)
    dfs=$(echo "$sc" | grep -E 'freq: (5[4-6][0-9][0-9])' | sort -u)
    if [ -n "$dfs" ]; then
      say "dfs_beacons_seen=yes"
      echo "$dfs" | head -10 | while read -r l; do say "  $l"; done
    else
      say "dfs_beacons_seen=no"
    fi
    say "total_bss=$(echo "$sc" | grep -c '^BSS')"
  fi
fi

# ---------- verdict ----------
say ""
say "--- verdict ---"
say "If [3] says unii2c_channels_present=NO  -> firmware/driver layer."
say "If [2] says kernel_regdomain=00         -> regdb world domain."
say "If [1] and [2] both say $CC_WANT but [3] lacks UNII-2C -> Qualcomm cfg/NV."
say "If [5] sees the AP but [3] forbids it   -> passive-scan only, no fix."
exit 0
