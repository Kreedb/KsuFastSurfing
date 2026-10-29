#!/system/bin/sh
# "Run" button in KernelSU Manager: rebuild hosts from user-hosts and remount.
# Offline and deterministic - it never probes, because detection is a read-only
# tool the user runs from the WebUI and confirms there.
MODDIR=${0%/*}
sh "$MODDIR/manager.sh" apply
sh "$MODDIR/manager.sh" status
exit 0
