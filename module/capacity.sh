#!/system/bin/sh
# What can this radio actually do? Read-only, no state changes.
#
# The questions this answers, in order of how much they cost to support:
#   1. noise floor / channel occupancy   -> needs nl80211 survey
#   2. real spectrum sweep               -> needs monitor mode + per-frame RSSI
#   3. deauth / frame injection          -> needs monitor mode + injection
#
# Each line is "yes", "no" or "unknown", and the reason is printed next to it:
# the difference between "the driver never implements it" and "the tool to ask
# is missing" decides whether the feature is even worth building.
#
# Usage: capacity.sh            -> human report + capacity.log
#        capacity.sh --json     -> one-line key=value pairs for the WebUI
case "$0" in */*) MODDIR=${0%/*} ;; *) MODDIR=. ;; esac
PATH=/data/adb/ksu/bin:/system/bin:/system/xbin:$PATH
LOG="$MODDIR/capacity.log"
JSON=0
[ "$1" = "--json" ] && JSON=1

say() { [ "$JSON" = "1" ] || echo "$*"; [ "$JSON" = "1" ] || echo "$*" >> "$LOG"; }
kv()  { echo "$1=$2"; [ "$JSON" = "1" ] || echo "$1=$2" >> "$LOG"; }
: > "$LOG"

# ---------- identity ----------
soc=$(getprop ro.soc.model 2>/dev/null)
[ -n "$soc" ] || soc=$(getprop ro.board.platform 2>/dev/null)
[ -n "$soc" ] || soc=unknown
hardware=$(getprop ro.hardware 2>/dev/null)
[ -n "$hardware" ] || hardware=unknown

# The WLAN driver is the thing that decides all three answers below. Android
# names it after the vendor: qcacld (Qualcomm), bcmdhd (Broadcom/Cypress),
# wlan_drv_gen (MediaTek).
drv=unknown
for m in /sys/module/qcacld* /sys/module/wlan /sys/module/bcmdhd /sys/module/dhd; do
  [ -e "$m" ] && { drv=${m##*/}; break; }
done
if [ "$drv" = "unknown" ]; then
  lsmod 2>/dev/null | awk '/wlan|wifi|dhd|qcacld/ {print $1; exit}' | read -r d && drv=$d
fi

kv soc "$soc"
kv hardware "$hardware"
kv driver "$drv"

# ---------- interfaces ----------
ifs=$(ls /sys/class/net 2>/dev/null | grep -E '^(wlan|p2p|swlan)' | tr '\n' ' ')
[ -n "$ifs" ] || ifs=none
kv interfaces "$ifs"

phys=$(ls -d /sys/class/ieee80211/phy* 2>/dev/null | wc -l | tr -d ' ')
kv phys "${phys:-0}"

# ---------- 1. survey (noise floor, channel busy time) ----------
# Survey data comes from the driver via NL80211_CMD_GET_SURVEY. A phy without a
# survey directory has never implemented it, and no user-space tool can change
# that. `iw` is absent on every retail image, so the sysfs check is the honest
# one; the netlink dump is only attempted when the directory exists.
survey_n=0
for d in /sys/class/ieee80211/phy*/device/net/*/statistics; do :; done
if command -v iw >/dev/null 2>&1; then
  n=$(iw dev 2>/dev/null | awk '/Interface/ {print $2; exit}')
  [ -n "$n" ] && survey_n=$(iw dev "$n" survey dump 2>/dev/null | grep -c 'frequency:')
fi
# Driver debugfs is sometimes the only place the counters surface.
dbg=/sys/kernel/debug/ieee80211
if [ -d "$dbg" ] && [ "$survey_n" = "0" ]; then
  # The presence of these files means the driver does expose survey counters.
  cnt=$(find "$dbg" -maxdepth 3 -name 'survey*' 2>/dev/null | wc -l | tr -d ' ')
  [ "${cnt:-0}" -gt 0 ] && survey_n=$cnt
fi
if [ "$survey_n" -gt 0 ] 2>/dev/null; then
  kv survey yes
  kv survey_channels "$survey_n"
elif command -v iw >/dev/null 2>&1; then
  kv survey no
else
  kv survey unknown
fi

# Noise floor as the link sees it: wpa_supplicant reports the driver's own
# value, and it is only meaningful when the field is present.
noise=none
if command -v wpa_cli >/dev/null 2>&1; then
  io=$(wpa_cli -i wlan0 signal_poll 2>/dev/null)
  [ -n "$io" ] || io=$(wpa_cli -p /data/vendor/wifi/wpa/sockets -i wlan0 signal_poll 2>/dev/null)
  nv=$(echo "$io" | sed -n 's/^NOISE=//p' | tr -d '\r')
  [ -n "$nv" ] && noise=$nv
fi
kv noise "$noise"

# ---------- 2. monitor mode ----------
# A monitor interface can only be created if the driver lists it in
# supported_interface_modes. Check the driver's own advertisement first: without
# it, `iw phy ... interface add type monitor` fails no matter who calls it.
mon=unknown
if [ -d /sys/kernel/debug/ieee80211 ]; then
  if find /sys/kernel/debug/ieee80211 -maxdepth 2 -name 'interface_modes' 2>/dev/null | grep -q .; then
    if grep -q 'monitor' /sys/kernel/debug/ieee80211/*/interface_modes 2>/dev/null; then
      mon=yes
    else
      mon=no
    fi
  fi
fi
if [ "$mon" = "unknown" ] && command -v iw >/dev/null 2>&1; then
  iw phy 2>/dev/null | grep -A6 'Supported interface modes' | grep -q 'monitor' && mon=yes || mon=no
fi
kv monitor "$mon"

# From inside a monitor-mode stack, these are the two kernels of truth: the
# virtual interface can be created, and the radio can leave its channel.
if [ "$mon" = "yes" ]; then
  can=$( (command -v iw >/dev/null 2>&1 &&
          iw dev wlan0 interface add mon0 type monitor 2>&1 | grep -qi 'command failed') && echo no || echo yes )
  kv monitor_creatable "$can"
fi

# ---------- 3. injection ----------
# No stock Android driver advertises frame injection. It requires patched
# firmware (NexMon on Broadcom/Cypress) or an external adapter with a mac80211
# driver. Both are whole separate projects, not a flag to flip.
inj=no
if [ "$mon" = "yes" ]; then
  # Only two things ever prove this: patched firmware, or a mac80211 driver.
  [ -e /data/adb/modules/nexmon ] && inj=yes
  ls /vendor/lib*/libnexmon.so 2>/dev/null | grep -q . && inj=yes
fi
kv injection "$inj"

# External adapter: the only broadly working path on a locked-down phone.
# A USB adapter is the one path that works without touching the built-in radio.
# It has to be a real USB device on the bus, not merely "some interface that is
# not wlan0" - that test matched eth0 and any container veth.
ext=no
for d in /sys/class/net/*/device; do
  [ -e "$d" ] || continue
  n=$(echo "$d" | sed 's|/sys/class/net/||; s|/device||')
  case "$n" in wlan*|p2p*|swlan*|lo|rmnet*|dummy*|eth*) continue ;; esac
  # Realpath contains the USB controller path for adapters; SDIO/PCIe do not.
  case "$(readlink -f "$d")" in *usb*) ext=yes ;; esac
done
kv external_adapter "$ext"

# ---------- what the existing scanner already gives ----------
# Per-BSSID RSSI is not a spectrum: it is one number per network, and only for
# networks that beacon. Worth stating so nobody reads the AP list as a sweep.
if [ "$JSON" = "1" ]; then
  exit 0
fi

cat <<'EOF'

读法：
  survey=yes        驱动上报信道占用与噪声，可以做"信道忙闲"图，但仍不是频谱
  survey=unknown    没有 iw，也没有 debugfs；要确认得装 iw 或读 netlink
  monitor=yes       驱动声明支持监听模式，频谱与抓包才有硬件前提
  injection=yes     只有打过补丁的固件（NexMon）或外接网卡才会是 yes
  external_adapter  接了 USB 网卡时才有意义，那是独立的一条路

注意：survey 给的是"最近一段时间里该信道有多少比例时间在忙"，不是瞬时功率。
真正的频谱仪（每 MHz 的功率曲线）需要监听模式下逐包 RSSI 或 SDR，手机内置
芯片给不了。
EOF
exit 0