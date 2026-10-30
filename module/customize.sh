SKIPUNZIP=0
set_perm_recursive "$MODPATH" 0 0 0755 0644
for f in post-fs-data.sh uninstall.sh customize.sh; do
  set_perm "$MODPATH/$f" 0 0 0755
done
set_perm "$MODPATH/hosts" 0 0 0644
set_perm "$MODPATH/system/etc/hosts" 0 0 0644
set_perm "$MODPATH/config" 0 0 0644
set_perm "$MODPATH/user-hosts" 0 0 0644
set_perm "$MODPATH/system.prop" 0 0 0644
set_perm "$MODPATH/domains" 0 0 0644
ui_print "- 所有操作都在 WebUI：扫描 / 探测 / 诊断 / 保存 hosts / 国家码"
ui_print "- 模块没有后台采集脚本；开机只挂载上次保存的 hosts"
ui_print "- 首次安装后打开 WebUI，检测一次并保存"
