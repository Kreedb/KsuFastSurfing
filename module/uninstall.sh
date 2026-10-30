#!/system/bin/sh
# Restore everything this module changed on the running system.
cmd wifi force-country-code disabled 2>/dev/null
# The vendor WCNSS overlay is not mounted by this version any more; the extra
# target only clears one left behind by a v2.2 install when the module is
# removed in the same boot it was upgraded in.
for t in /system/etc/hosts /etc/hosts /vendor/etc/wifi/WCNSS_qcom_cfg.ini; do
  umount "$t" 2>/dev/null
done
exit 0
