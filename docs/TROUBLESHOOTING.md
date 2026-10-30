# 排障

## 先看控制台

WebUI 第五个选项卡「控制台」打印页面发出的每一条命令、退出码、耗时与输出摘要。
任何数字不对，先在这里找上一条 `$` 命令和它的 `→ rc=…`。

- `!` 开头 = 命令失败或超时
- 输出被截断时，摘要会写“共 N 行 / M 字节”
- 「复制全部」可以把整段贴进 issue

页面不再写 `probe.log` / `diagnose.log` / `manager.log`。设备上还会留下的运行时文件只有：

```sh
cat /data/adb/modules/KsuFastSurfing/mount.log    # 开机属性 / vendor overlay / 挂载
```

## 状态一次看全

页面顶部状态条只给结论；字段级状态在 hosts 页与国家码页。命令行等价检查：

```sh
su -c 'wc -l /data/adb/modules/KsuFastSurfing/user-hosts'
su -c 'cat /data/adb/modules/KsuFastSurfing/hosts'
su -c 'cmp -s /data/adb/modules/KsuFastSurfing/hosts /system/etc/hosts; echo same=$?'
su -c 'mount | grep " /system/etc/hosts "'
su -c 'cmd wifi get-country-code'
```

`user` 是编辑框里的非注释行数，`entries` 是合并后实际生效的条数；
两者差值就是被去重的行数。

## 常见现象

| 现象 | 常见原因 | 怎么确认 / 处理 |
|---|---|---|
| 显示“未挂载” | 未重启；SELinux 阻止 bind mount；另一份 hosts 覆盖 | 控制台看 `mount -o bind` 的 `mounted=0`；`mount.log` 只有开机记录 |
| hosts 生效但没加速 | 应用走 DoT / DoH，绕过 hosts | 关闭系统「私人 DNS」再测；`ping` 域名看解析结果 |
| 检测 0 个候选 | 所有解析方式都拿不到地址：DNS 被拦、未联网、域名拼错 | 控制台看 `resolve ... -> none`；调超时无效 |
| 有候选但全不可达 | 443 连不上：被墙、IP 失效、网络需要代理 | 看 `fail` 行；换网络或换域名 |
| 检测按钮很久没反应 | 正在解析 / 连接；日志面板应持续更新 | 看控制台最后一条 `$`；每个 curl 有 3 秒上限 |
| 检测结束但编辑框没变 | 所有域名编辑框里已有，未覆盖 | 状态条会写“M 条已存在未覆盖” |
| 检测提示没有 curl | ROM 没带 curl | 控制台看 `command -v curl`；换带 curl 的 ROM / busybox |
| 保存失败 | 写入或挂载出错 | 控制台看 `write=FAIL` 或 `mounted=0`；状态条指向控制台 |
| MAC 显示星号 | 框架在没有定位权限时抹掉 BSSID 中段，root 也无法还原 | 不编造地址；属预期行为，不影响信道/干扰结论 |
| 中文 SSID 乱码 | 未走 base64 传输，或框架截断在多字节字符中间 | 确认使用当前版本；`shRaw()` 已按字节传输 |
| 国家码不生效 | 厂商 ROM 固定在 vendor 层 | 控制台看 `force-country-code` 返回；点「运行完整诊断」看层 |
| 国家码生效但无 ch100-144 | 固件信道表没有 UNII-2C | 诊断的 `bss_unii2c=0` 即硬限制，软件无解 |
| WebUI 全空 / 按钮无反应 | 页面加载失败，或误用了 npm 的 `kernelsu` import | 从管理器打开；看页面是否提示“接口不可用” |
| 扫描后仍显示旧数据 | 框架复用缓存，没有新结果 | 状态条会说明“没有回来新结果”；换位置再试 |
| 控制台没有新行 | 命令还没返回，或页面被切到后台 | 看状态条是否仍在 running |

## 一次收集排障信息

```sh
su -c 'cat /data/adb/modules/KsuFastSurfing/mount.log'
su -c 'cat /data/adb/modules/KsuFastSurfing/config'
su -c 'cmd wifi status'
su -c 'cmd wifi list-scan-results | head -30'
su -c 'mount | grep hosts'
```

再附上控制台里最近 20 行（`$` 与 `→ rc=` 成对出现），足够定位问题。
不需要整份 `dumpsys`。

## 明确不是 bug 的情况

- 开机后 hosts 还是上次保存的内容：模块不做开机采集，这是设计
- DFS AP 发现慢：DFS 默认被动扫描，只能等信标
- 隐藏 SSID 的 DFS AP 扫不到：被动扫描无法发现隐藏网络，只能手动添加
- 控制台里 `command -v iw` 返回 1：零售 ROM 通常没有 `iw`，诊断已按无 `iw` 设计
