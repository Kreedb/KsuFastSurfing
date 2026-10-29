SKIPUNZIP=0
set_perm_recursive "$MODPATH" 0 0 0755 0644
for f in post-fs-data.sh action.sh uninstall.sh manager.sh customize.sh diagnose.sh probe.sh capacity.sh collect.sh; do
  set_perm "$MODPATH/$f" 0 0 0755
done
set_perm "$MODPATH/hosts" 0 0 0644
set_perm "$MODPATH/system/etc/hosts" 0 0 0644
set_perm "$MODPATH/config" 0 0 0644
set_perm "$MODPATH/user-hosts" 0 0 0644
set_perm "$MODPATH/system.prop" 0 0 0644
set_perm "$MODPATH/domains" 0 0 0644
ui_print "- hosts: 检测只读，结果先进编辑框，点保存才生效"
ui_print "- hosts 条目: WebUI 里编辑，单按钮写入 user-hosts 并挂载"
ui_print "- WiFi 国家码: 默认 US，可在 WebUI 修改"
ui_print "- WiFi 诊断: 打开 WebUI（manager.sh diagnose 看国家码四层）"
