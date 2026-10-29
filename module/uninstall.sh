#!/system/bin/sh
cmd wifi force-country-code disabled 2>/dev/null
for t in /system/etc/hosts /etc/hosts; do umount "$t" 2>/dev/null; done
exit 0
