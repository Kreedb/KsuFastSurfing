#!/system/bin/sh
# "Run" button in KernelSU Manager: refresh from cloud and re-apply.
MODDIR=${0%/*}
sh "$MODDIR/manager.sh" refresh
sh "$MODDIR/manager.sh" status
exit 0
