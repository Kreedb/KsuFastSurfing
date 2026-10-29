#!/bin/sh
# Verify wifidiag.awk renders correctly from a hostile scan cache.
#
# The fixtures deliberately use SSIDs containing '|', '=', '"', '\' and UTF-8.
# The previous key=value format joined and split fields on '|', so an AP named
# "ap fake=1|2" produced freq=2, ch=5745, rssi=149 - wrong numbers rendered
# confidently. These assertions exist so that format cannot come back.
#
# Runs under busybox awk (what Android ships) and gawk (what CI has), because
# the two disagree about backslash handling in gsub replacements.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

cp "$ROOT/module/wifidiag.awk" "$ROOT/module/jsonlib.awk" "$T/"
mkdir -p "$T/diag/raw"

cat > "$T/diag/raw/scan.txt" <<'FIX'
BSSID              Frequency      RSSI           Age(sec)     SSID                                 Flags
  68:19:aa:bb:cc:01       5500    -25(0:-25/1:-30)    3.1    Coffee | Bar = 7        [RSN-PSK][ESS]
  68:19:aa:bb:cc:02       5180    -60(0:-60/1:-65)    4.2    it's "quoted" \ back    [RSN-PSK][ESS]
  68:19:aa:bb:cc:03       2437    -70(0:-70/1:-75)    5.0    咖啡馆 2.4G              [WPA2-PSK][ESS]
  68:19:aa:bb:cc:04       5745    -80(0:-80/1:-85)    6.7    ap fake=1|2             [RSN-PSK][ESS]
FIX

printf 'gw=192.168.1.1\n5 packets transmitted, 5 packets received, 0%% packet loss\nrtt min/avg/max/mdev = 1.2/2.4/3.6/0.8 ms\ndns=ok\n' \
  > "$T/diag/raw/net.txt"

printf 'WifiInfo: SSID: "Cafe | Bar=7", BSSID: 68:19:aa:bb:cc:01, Wi-Fi standard: 11ax, RSSI: -25, Link speed: 1200Mbps, Frequency: 5500MHz\n' \
  > "$T/diag/raw/link.txt"

fail=0
for impl in awk "busybox awk"; do
  echo "== $impl =="
  # shellcheck disable=SC2086
  if ! $impl -f "$T/jsonlib.awk" -f "$T/wifidiag.awk" -v out_fmt=json \
      "$T/diag/raw/scan.txt" "$T/diag/raw/link.txt" "$T/diag/raw/net.txt" > "$T/out.json"; then
    echo "  FAIL: $impl exited non-zero"; fail=1; continue
  fi
  OUT="$T/out.json" python3 "$ROOT/tests/assert_diag.py" || fail=1
done

busybox awk -f "$T/jsonlib.awk" -f "$T/wifidiag.awk" -v out_fmt=text \
  "$T/diag/raw/scan.txt" "$T/diag/raw/link.txt" "$T/diag/raw/net.txt" > "$T/out.txt"

grep -qx 'total=4' "$T/out.txt" || { echo "FAIL: text total mismatch"; sed -n '1,5p' "$T/out.txt"; fail=1; }
grep -qx '\[verdict\]' "$T/out.txt" || { echo "FAIL: text missing verdict section"; fail=1; }
# The fixture has only four APs, so an empty non-DFS 5GHz channel (44) is a
# correct answer - asserting a specific number would encode the fixture rather
# than the rule. Assert the rule: the pick must be 5GHz and must not be DFS.
pick=$(sed -n 's/^best_ch=//p' "$T/out.txt")
[ -n "$pick" ] || { echo "FAIL: text has no best_ch"; fail=1; }
case "$pick" in
  none) echo "FAIL: text best_ch=none despite a successful scan"; fail=1 ;;
  [0-9]*) ;;
  *)     echo "FAIL: text best_ch is not numeric: $pick"; fail=1 ;;
esac
if [ "$pick" -lt 35 ] 2>/dev/null; then
  echo "FAIL: text best_ch=$pick is a 2.4GHz channel while 5GHz is present"; fail=1
fi
sed -n 's/^sc \([0-9]*\)|\([0-9]*\)|\([0-9]*\)|\([0-9]*\)|\([0-9]*\)|\([0-9]*\)$/\1 \5/p' "$T/out.txt" > "$T/score.txt"
head -1 "$T/score.txt" | {
  read -r ch dfs
  if [ "$dfs" = "1" ]; then echo "FAIL: text top pick ch$ch is DFS"; fail=1; fi
}

exit $fail