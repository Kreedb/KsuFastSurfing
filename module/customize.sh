SKIPUNZIP=0
set_perm_recursive "$MODPATH" 0 0 0755 0644
for f in post-fs-data.sh service.sh action.sh uninstall.sh manager.sh customize.sh; do
  set_perm "$MODPATH/$f" 0 0 0755
done
set_perm "$MODPATH/hosts" 0 0 0644
set_perm "$MODPATH/system/etc/hosts" 0 0 0644
set_perm "$MODPATH/config" 0 0 0644
set_perm "$MODPATH/user-hosts" 0 0 0644
set_perm "$MODPATH/system.prop" 0 0 0644
set_perm "$MODPATH/sources/mtalk.hosts" 0 0 0644
set_perm "$MODPATH/sources/github.hosts" 0 0 0644
ui_print "- 云端源: fcm-hosts (mtalk) + github-hosts (GitHub)"
ui_print "- 手动条目: 通过 WebUI 编辑 user-hosts"
ui_print "- WiFi 国家码: 默认 US，可在 WebUI 修改"
