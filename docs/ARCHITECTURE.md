# 架构

## 一张图

```
                    KernelSU / Magisk Manager
                              │ 打开 WebUI
                              ▼
                 webroot/index.html + diag.js
                    │            │            │
          ksu.exec  │            │            │
                    ▼            ▼            ▼
              collect.sh      probe.sh     manager.sh
              （只读采集）    （只读探测）   （唯一控制面）
                    │            │            │
                    │            │      ┌─────┴──────────────┐
                    │            │      ▼                    ▼
                    │            │  user-hosts ──build──▶ hosts
                    │            │                            │ bind mount
                    │            │                            ▼
                    │            │                  /system/etc/hosts
                    │            │                  /etc/hosts（若存在）
                    │            │
                    │            └──▶ probe.log（页面轮询）
                    └──▶ ##scan / ##link / ##route / ##ping / ##dns / ##mac

post-fs-data.sh ──▶ manager.sh build + 属性注入 + vendor cfg overlay + remount
action.sh       ──▶ manager.sh apply + status
uninstall.sh    ──▶ 关闭国家码、卸载所有 bind mount
```

没有常驻进程。模块在系统里留下的东西只有文件与 bind mount，卸载脚本会把两者都撤掉。

## 生命周期

| 时机 | 脚本 | 做什么 | 联网 |
|---|---|---|---|
| 安装 | `customize.sh` | 设置 POSIX 权限位，打印使用提示 | 否 |
| 开机 | `post-fs-data.sh` | 合并 hosts、注入国家码属性、overlay 厂商 WLAN 配置、挂载 | **否** |
| 管理器「运行」 | `action.sh` | `manager.sh apply` + `status` | 否 |
| 打开 WebUI | `index.html` | 读 `user-hosts` 与状态，采集一次诊断数据 | 是（仅一次 DNS 连通性检查） |
| 用户点「检测 IP」 | `probe.sh` | 解析并测速，stdout + `probe.log` | 是 |
| 用户点「保存并应用」 | `manager.sh apply` | 写 `user-hosts` 后重建并挂载 | 否 |
| 卸载 | `uninstall.sh` | `cmd wifi force-country-code disabled`、umount | 否 |

`post-fs-data` 有 10 秒硬预算，所以这里只做本地文件操作。模块**没有 `service.sh`**：
开机不会自动探测、不会自动改写 hosts、不会在后台发起任何请求。

## 唯一控制面

`manager.sh` 是唯一会改变系统状态的脚本。子命令：

| 命令 | 作用 | 是否改状态 |
|---|---|---|
| `build` | `user-hosts` → `hosts`，同步 `system/etc/hosts` | 改文件，不挂载 |
| `remount` | 把 `hosts` bind mount 到 `/system/etc/hosts`、`/etc/hosts` | 改挂载 |
| `apply` | `build` + `remount` | 是 |
| `status` | 输出 `user/entries/mounted/cc/cur_cc/timeout/threads` | 否 |
| `set-cc XX` | 写 `config`、`system.prop`，立即 `cmd wifi` + `iw reg set` | 是 |
| `diagnose` | 调 `diagnose.sh`，四层信道诊断 | 否 |
| `capacity` | 调 `capacity.sh`，射频能力探测 | 否 |

`build` / `remount` 保留为独立子命令，是为了让 `post-fs-data` 能把“写文件”和“挂载”
分两步记日志；日常只需要 `apply`。

## hosts 管线

```
user-hosts（唯一来源）
    │  awk：跳过注释/空行，校验第一列是 IPv4 或 IPv6
    │       按域名去重，第一条胜出
    ▼
hosts（生成文件，带时间戳头 + localhost + 用户条目）
    │  cp
    ├──▶ module/system/etc/hosts（metamodule 路径的备份）
    └──▶ bind mount → /system/etc/hosts
                    → /etc/hosts（解析为同一 inode 时只挂一次）
```

要点：

- **单一来源**：没有第二层、没有 `USE_PROBED` 开关。检测结果只有进入编辑框、用户按保存后
  才会写进 `user-hosts`
- **首条胜出**：同一个域名出现多次时保留第一条；`status` 的 `user` 与 `entries` 因此可能不同，
  这个差值就是被去重的行数
- **挂载目标去重**：`/etc/hosts` 常是 `/system/etc/hosts` 的符号链接，`readlink -f` 后只挂一次
- **可重入**：每次挂载前先 `umount` 目标；失败只记日志，不中断开机

### 为什么还要 `module/system/etc/hosts`

主路径是 bind mount。但 KernelSU 把 `/system` 挂载交给 metamodule（如 meta-overlayfs），
只放 `module/system/etc/hosts` 在没装 metamodule 的设备上完全不生效——这是“刷了没反应”
的常见原因。两条路喂同一份内容，哪条通都能工作。

## 国家码

四层约束，`manager.sh` 只能影响前三层：

| 层 | 谁在管 | 模块的做法 |
|---|---|---|
| framework | WifiService / `cmd wifi` | 用户应用国家码时执行 `cmd wifi force-country-code enabled XX` |
| 属性 | init / 厂商 HAL | `resetprop` 写 `ro.boot.wificountrycode` 等 4 个键 |
| 驱动 / 固件配置 | 厂商 BDF / `WCNSS_qcom_cfg.ini` | 复制并改 `gStaCountryCode`，bind mount 覆盖 `/vendor` 原文件 |
| 射频能力 | 硬件与固件信道表 | **改不了**，只能由 `diagnose` / `capacity` 报告 |

属性注入发生在 `post-fs-data`（zygote 之前），因为 WiFi 服务初始化时读的是属性；
`cmd wifi` 只能改运行时状态，单独使用在部分 ROM 上会被开机流程覆盖。

`set-cc` 会同步写 `config` 与 `system.prop`，并立即尝试运行时接口；vendor overlay 在
下一次开机由 `post-fs-data` 重新生成。`cc_current` 同时兼容 `cmd wifi get-country-code`
与 `dumpsys wifi` 两种输出，取最后一个两字母大写片段，避免把 “COUNTRY CODE IS: US”
整行显示到页面。

## 文件职责

| 路径 | 职责 |
|---|---|
| `module/module.prop` | 模块元数据（id / 版本 / 描述） |
| `module/config` | `CC`、`PROBE_TIMEOUT`、`PROBE_THREADS` |
| `module/manager.sh` | 控制面：build / remount / apply / status / set-cc / diagnose / capacity |
| `module/collect.sh` | 一次采集诊断数据，按 `##section` 分段输出 |
| `module/probe.sh` | 本机 IP 探测，只读，stdout 输出冠军行，过程写 `probe.log` |
| `module/diagnose.sh` | 国家码四层诊断（只读） |
| `module/capacity.sh` | survey / monitor / injection 能力探测（只读） |
| `module/post-fs-data.sh` | 开机：合并、属性、vendor overlay、挂载 |
| `module/action.sh` | 管理器「运行」按钮：apply + status |
| `module/uninstall.sh` | 卸载清理 |
| `module/customize.sh` | 安装期权限与提示 |
| `module/domains` | 待探测域名，一行一个 |
| `module/user-hosts` | 唯一用户输入，由「保存并应用」写入 |
| `module/hosts` | 合并产物，`build` 生成 |
| `module/system/etc/hosts` | metamodule 路径的副本 |
| `module/system.prop` | `set-cc` 生成的国家码属性 |
| `module/webroot/index.html` | 页面结构、样式、交互 |
| `module/webroot/diag.js` | 数据层：解析、分析、采集封装 |
| `tests/` | Node 回归测试，不依赖设备 |

### 运行时文件（设备上）

| 文件 | 内容 |
|---|---|
| `mount.log` | 开机合并 / 属性 / vendor overlay / 挂载结果 |
| `manager.log` | build / remount / 国家码操作 |
| `probe.log` | 检测过程，页面轮询读取 |
| `diagnose.log` | `diagnose.sh` 的完整转储 |
| `.probe/` | 探测临时目录，每次启动清空 |

## 不变量

改代码时不要破坏这几条：

1. 开机路径不联网、不等待网络、不做重试风暴
2. 检测只读；只有「保存并应用」会写 `user-hosts` 并挂载
3. `user-hosts` 是唯一输入；合并必须按域名去重且首条胜出
4. `manager.sh` 之外不出现第二套状态修改逻辑
5. 所有挂载可重入；失败只记日志，不阻塞开机
6. 页面拿不到数据时显示“未知”，不用 0 或猜测填充
7. 构建不得修改仓库中的源文件（只在暂存副本里内联 `diag.js`）
