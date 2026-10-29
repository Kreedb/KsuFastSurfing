#!/system/bin/sh
# Restore everything this module changed on the running system.
cmd wifi force-country-code disabled 2>/dev/null
for t in /system/etc/hosts /etc/hosts /vendor/etc/wifi/WCNSS_qcom_cfg.ini; do
  umount "$t" 2>/dev/null
done
exit 0
