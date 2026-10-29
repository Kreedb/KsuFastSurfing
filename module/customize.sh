SKIPUNZIP=0
set_perm_recursive "$MODPATH" 0 0 0755 0644
for f in post-fs-data.sh service.sh action.sh uninstall.sh manager.sh customize.sh diagnose.sh probe.sh wifidiag.sh; do
  set_perm "$MODPATH/$f" 0 0 0755
done
set_perm "$MODPATH/hosts" 0 0 0644
set_perm "$MODPATH/system/etc/hosts" 0 0 0644
set_perm "$MODPATH/config" 0 0 0644
set_perm "$MODPATH/user-hosts" 0 0 0644
set_perm "$MODPATH/system.prop" 0 0 0644
set_perm "$MODPATH/domains" 0 0 0644
ui_print "- hosts: 本机 DNS + TLS 握手测速，不预置云端源"
ui_print "- 手动条目: 通过 WebUI 编辑 user-hosts（优先级最高）"
ui_print "- WiFi 国家码: 默认 US，可在 WebUI 修改"
ui_print "- WiFi 诊断: 打开 WebUI 或运行 manager.sh wifi"
