#!/system/bin/sh
# "Run" button in KernelSU Manager: re-probe IPs locally and re-apply.
# No cloud source is involved any more - probe.sh measures this device's network.
MODDIR=${0%/*}
sh "$MODDIR/manager.sh" refresh
sh "$MODDIR/manager.sh" status
exit 0
