# 排障

## 先看这四个文件

```sh
cat /data/adb/modules/KsuFastSurfing/mount.log     # 开机合并 / 属性 / vendor overlay / 挂载
cat /data/adb/modules/KsuFastSurfing/manager.log   # build / remount / 国家码
cat /data/adb/modules/KsuFastSurfing/probe.log     # 检测过程
cat /data/adb/modules/KsuFastSurfing/diagnose.log  # 四层诊断转储
```

状态一次看全：

```sh
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh status'
```

输出字段：`user`（编辑框非注释行数）、`entries`（实际生效条数）、`mounted`、
`cc` / `cur_cc`、`timeout` / `threads`。

## 常见现象

| 现象 | 常见原因 | 怎么确认 / 处理 |
|---|---|---|
| `mounted=0` | 未重启；SELinux 阻止 bind mount | 看 `mount.log` 的 `remount failed`；确认已重启 |
| hosts 生效但没加速 | 应用走 DoT / DoH，绕过 hosts | 关闭系统「私人 DNS」再测；`ping` 域名看解析结果 |
| 检测 0 个候选 | 所有解析方式都拿不到地址：DNS 被拦、未联网、域名拼错 | 看 `probe.log` 的 `resolve ... -> none`；调 `PROBE_TIMEOUT` 无效 |
| 有候选但全不可达 | 443 连不上：被墙、IP 失效、网络需要代理 | 看 `fail` 行；换网络或换域名 |
| 检测按钮很久没反应 | 正在解析 / 连接；日志面板应持续更新 | 看 `probe.log` 最后一行；90 次轮询后会自动结束 |
| 检测结束但编辑框没变 | 所有域名编辑框里已有，未覆盖 | 状态条会写“M 条已存在未覆盖” |
| 保存失败 | `rc` 非 0：写入或挂载出错 | 详情面板有原始输出；看 `manager.log` |
| MAC 显示星号 | ROM 没有 `wpa_cli`，只能拿框架脱敏值 | 不编造地址；属预期行为 |
| 中文 SSID 乱码 | 未走 base64 传输，或框架截断在多字节字符中间 | 确认使用当前版本；`collect.sh` 已按字节传输 |
| 国家码不生效 | 厂商 ROM 固定在 vendor 层 | 看 `manager.log` 的 `cmd wifi` 返回；`diagnose` 看层 |
| 国家码生效但无 ch100-144 | 固件信道表没有 UNII-2C | `diagnose` 的 `bss_unii2c=0` 即硬限制，软件无解 |
| WebUI 全空 / 按钮无反应 | 页面加载失败，或误用了 npm 的 `kernelsu` import | 从管理器打开；看页面是否提示“接口不可用” |
| 扫描后仍显示旧数据 | 框架复用缓存，没有新结果 | 状态条会说明“没有回来新结果”；换位置再试 |

## 一次收集排障信息

```sh
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh status'
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh diagnose'
su -c 'sh /data/adb/modules/KsuFastSurfing/collect.sh'
su -c 'sh /data/adb/modules/KsuFastSurfing/capacity'
```

`collect.sh` 的输出就是 WebUI 看到的数据；`diagnose` 会同时写 `diagnose.log`。
报告问题时附上 `status`、`mount.log` 与 `probe.log` 的最后 20 行即可，不需要整份转储。

## 明确不是 bug 的情况

- 开机后 hosts 还是上次保存的内容：模块不做开机探测，这是设计
- DFS AP 发现慢：DFS 默认被动扫描，只能等信标
- 隐藏 SSID 的 DFS AP 扫不到：被动扫描无法发现隐藏网络，只能手动添加
- `capacity` 三项都不支持：硬件 / 固件限制，不是脚本失败
