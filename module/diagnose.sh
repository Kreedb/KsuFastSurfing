#!/system/bin/sh
# Diagnose why 5GHz DFS channels (100-144) stay invisible. Read-only.
# Deliberately avoids `iw`: most retail Android images simply don't ship it,
# which made the previous version report "iw unavailable" for three of the
# five layers (see the fallbacks below).
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
st=$(cmd wifi status 2>&1)
# dumpsys carries the authoritative values; cmd wifi status does not print them
dcc=$(dumpsys wifi 2>/dev/null | grep -iE '^(Current|Persistent|Telephony|OEM) Country ?Code:' | head -6)
if [ -n "$dcc" ]; then
  echo "$dcc" >> "$OUT"
  echo "$dcc" | sed 's/^/  /'
else
  say "  (dumpsys produced no Country Code lines)"
fi
cur=$(echo "$dcc" | grep -i '^Current Country' | head -1 | sed 's/.*: *//' | tr -d '\r')
tree=$(echo "$dcc" | grep -iE '^(Persistent|Telephony|OEM)' | tr '\n' ' ')
say "framework_cc=${cur:-unknown}"
say "framework_sources=${tree:-none}"
say "settings_country=$(settings get global wifi_country_code 2>/dev/null)"

# ---------- 2. kernel / wpa_supplicant ----------
say ""
say "--- [2] wpa_supplicant (acts as the regdb hint) ---"
sup=""
for f in /data/misc/apexdata/com.android.wifi/WifiSupplicantControl/wpa_supplicant.conf \
         /data/misc/wifi/wpa_supplicant.conf \
         /data/vendor/wifi/wpa/wpa_supplicant.conf; do
  [ -r "$f" ] || continue
  sup=$(grep -iE '^[[:space:]]*country=' "$f" 2>/dev/null | head -1 | sed 's/.*=//' | tr -d '\r')
  say "conf=$f"
  break
done
say "supplicant_country=${sup:-unset}"
if command -v iw >/dev/null 2>&1; then
  say "iw_reg=$(iw reg get 2>&1 | grep -o 'country [A-Z0-9][A-Z0-9]' | head -1 | awk '{print $2}')"
else
  say "iw_reg=n/a (iw not shipped on this image)"
fi

# ---------- 3. what the radio actually scanned ----------
say ""
say "--- [3] scan results (ground truth, no iw needed) ---"
SR=$(cmd wifi list-scan-results 2>&1)
echo "$SR" >> "$OUT"
n_all=$(echo "$SR" | awk 'NR>1 && $2 ~ /^[0-9]+$/ {c++} END{print c+0}')
say "bss_total=$n_all"
if [ "$n_all" = "0" ]; then
  say "  (no cached results - run: cmd wifi start-scan, then re-run this)"
fi
# 5GHz = 4900-5895, UNII-2C (ch100-144) = 5470-5725
n_5g=$(echo "$SR" | awk 'NR>1 && $2+0>=4900 && $2+0<=5895 {c++} END{print c+0}')
n_unii2c=$(echo "$SR" | awk 'NR>1 && $2+0>=5470 && $2+0<=5725 {c++} END{print c+0}')
say "bss_5ghz=$n_5g"
say "bss_unii2c=$n_unii2c"
if [ "$n_unii2c" -gt 0 ] 2>/dev/null; then
  say "  UNII-2C APs seen:"
  echo "$SR" | awk 'NR>1 && $2+0>=5470 && $2+0<=5725 {printf "    %s MHz  %s\n", $2, $5}' | head -10 >> "$OUT"
  echo "$SR" | awk 'NR>1 && $2+0>=5470 && $2+0<=5725 {printf "    %s MHz  %s\n", $2, $5}' | head -10 | sed 's/^/  /'
fi
say "freq_list=$(echo "$SR" | awk 'NR>1 && $2 ~ /^[0-9]+$/ {print $2}' | sort -un | tr '\n' ' ')"

# ---------- 4. vendor WLAN config ----------
say ""
say "--- [4] vendor WLAN config ---"
found=0
for f in /vendor/etc/wifi/WCNSS_qcom_cfg.ini \
         /vendor/etc/wifi/wifi_con_mode.conf \
         /odm/etc/wifi/WCNSS_qcom_cfg.ini; do
  [ -r "$f" ] || continue
  found=1
  say "found: $f"
  grep -iE 'country|regdom|11d' "$f" 2>/dev/null | head -8 | sed 's/^/    /' >> "$OUT"
  grep -iE 'country|regdom|11d' "$f" 2>/dev/null | head -8 | sed 's/^/  /'
done
[ "$found" = "0" ] && say "  (no WCNSS_qcom_cfg.ini found - this ROM uses BDF/NV, not the ini)"
say "vendor_overlay=$(mount 2>/dev/null | grep -c 'WCNSS_qcom_cfg')"

# ---------- 5. connected link ----------
say ""
say "--- [5] current link ---"
echo "$st" | grep -iE 'connected to|Frequency:' | sed 's/^[[:space:]]*/  /' | head -4 >> "$OUT"
echo "$st" | grep -iE 'WifiInfo:' | head -1 | cut -c1-160 | sed 's/^/  /'
say ""

# ---------- verdict ----------
say "--- verdict ---"
if [ -n "$cur" ] && [ "$cur" != "$CC_WANT" ]; then
  say "framework=$cur but config wants $CC_WANT -> the force-country-code call is not sticking"
elif [ "$cur" = "$CC_WANT" ]; then
  say "framework already $cur -> the country code IS applied; the block is elsewhere"
fi
if [ "${n_unii2c:-0}" -gt 0 ] 2>/dev/null; then
  say "UNII-2C APs ARE visible -> channels work; if Settings hides them, that is"
  say "  a UI/scan-cache issue, try: cmd wifi start-scan (twice, 10s apart)"
elif [ "${n_5g:-0}" -gt 0 ] 2>/dev/null; then
  say "5GHz visible but no UNII-2C AP -> either none nearby, or DFS is filtered."
  say "  Move next to the AP and re-run; if still 0, the radio is filtering DFS."
else
  say "No 5GHz at all -> check WLAN band setting / AP is on 2.4GHz."
fi
say "Deeper check (root): dmesg | grep -i -E 'regdom|country|dfs'"
exit 0
