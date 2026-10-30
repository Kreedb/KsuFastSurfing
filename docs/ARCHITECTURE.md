# 架构

## 一张图

```
                 KernelSU / Magisk Manager
                           │ 打开 WebUI
                           ▼
              webroot/index.html + diag.js
                           │  ksu.exec（每条命令都进控制台）
     ┌─────────────────────┼──────────────────────────┐
     ▼                     ▼                          ▼
 诊断采集               状态/写入                   国家码
 cmd wifi status        读 user-hosts / hosts       写 config / system.prop
 cmd wifi list-scan     mergeHosts()                resetprop ×4
 dumpsys / settings     写 hosts + system/etc/hosts  cmd wifi force-country-code
 ip route / ping        umount + mount -o bind      iw reg set（有 iw 时）
 (无 supplicant 调用)

post-fs-data.sh ──▶ 挂载上次保存的 hosts + 国家码属性 + vendor cfg overlay
customize.sh    ──▶ 安装期权限
uninstall.sh    ──▶ 关闭国家码、卸载 bind mount
```

模块里**没有** `manager.sh`、`collect.sh`、`probe.sh`、`diagnose.sh`、
`capacity.sh`、`action.sh`，也没有 `service.sh`。页面直接发 Android 原生命令，
自己解析、自己渲染、自己写文件。

## 为什么还留着三个 shell 文件

| 文件 | 为什么不能搬进页面 |
|---|---|
| `post-fs-data.sh` | 开机早期执行，那时 WebView 还不存在。它只做“把页面上次保存的 hosts 挂上去”，不采集、不联网 |
| `customize.sh` | 安装时由管理器执行，WebUI 还没有机会运行 |
| `uninstall.sh` | 卸载时页面已被移除，必须由钩子清理挂载 |

这三个是模块生命周期契约，不是后台数据脚本。除此之外没有任何 shell 参与功能。

## 生命周期

| 时机 | 谁 | 做什么 | 联网 |
|---|---|---|---|
| 安装 | `customize.sh` | 设置 POSIX 权限位，打印使用提示 | 否 |
| 开机 | `post-fs-data.sh` | 挂载 `module/hosts`、注入国家码属性、overlay 厂商 WLAN 配置 | **否** |
| 打开 WebUI | `index.html` | 读 `user-hosts` / `hosts` / `config`，采集一次扫描、链路、网关、DNS | 是（一次 DNS 连通性检查） |
| 点「保存并应用」 | 页面 | 写 `user-hosts`、合并 `hosts`、写两份副本、bind mount | 否 |
| 点「应用」国家码 | 页面 | 写 `config` / `system.prop`、`resetprop`、`cmd wifi`、`iw reg set` | 否 |
| 卸载 | `uninstall.sh` | `cmd wifi force-country-code disabled`、umount | 否 |

`post-fs-data` 有 10 秒预算，所以这里只做本地文件操作。

## 控制面

页面是唯一控制面。没有子命令，没有“运行”按钮脚本。

| 操作 | 页面函数 | 改状态 |
|---|---|---|
| 读状态 | `loadStatus()` | 否 |
| 读诊断 | `measure()` / `loadDiag()` | 否 |
| 保存并应用 | `h-save` handler | 是（写文件 + 挂载） |
| 应用国家码 | `c-set` handler | 是（写配置 + 属性 + 运行时） |
| 恢复自动 | `c-auto` handler | 是（`cmd wifi force-country-code disabled`） |
| 四层诊断 | `diagnoseLayers()` | 否 |

## hosts 管线

```
user-hosts（唯一来源）
    │  mergeHosts()：JS，跳过注释/空行，校验第一列是 IPv4 或 IPv6
    │               按域名去重，第一条胜出
    ▼
hosts（生成文件，带时间戳头 + localhost + 用户条目）
    │  writeFile()
    ├──▶ module/system/etc/hosts（metamodule 路径的备份）
    └──▶ bind mount → /system/etc/hosts
                    → /etc/hosts（readlink -f 后同一 inode 只挂一次）
```

要点：

- **单一来源**：没有第二层，没有 `USE_PROBED` 开关。检测结果只有进入编辑框、
  用户按保存后才会写进 `user-hosts`
- **首条胜出**：同一个域名出现多次时保留第一条；`user` 与 `entries` 因此可能不同，
  这个差值就是被去重的行数
- **挂载目标去重**：`mountTargets()` 先 `readlink -f` 两个目标，再由页面去重
- **可重入**：每次挂载前先 `umount`；失败写入控制台，不阻塞其他步骤

### 为什么还要 `module/system/etc/hosts`

主路径是 bind mount。但 KernelSU 把 `/system` 挂载交给 metamodule（如
meta-overlayfs），只放 `module/system/etc/hosts` 在没装 metamodule 的设备上
完全不生效——这是“刷了没反应”的常见原因。两条路喂同一份内容，哪条通都能工作。

## 国家码

四层约束，页面只能影响前三层：

| 层 | 谁在管 | 页面的做法 |
|---|---|---|
| framework | WifiService / `cmd wifi` | `cmd wifi force-country-code enabled XX`（带退避重试） |
| 属性 | init / 厂商 HAL | `resetprop` 写 4 个键 + `system.prop` |
| 驱动 / 固件配置 | 厂商 BDF / `WCNSS_qcom_cfg.ini` | `post-fs-data` 在下次开机 overlay |
| 射频能力 | 硬件与固件信道表 | **改不了**，只能由诊断报告可见信道 |

属性注入在开机时还要再做一次（zygote 之前），因为 WiFi 服务初始化时读的是属性；
`cmd wifi` 只能改运行时状态，单独使用在部分 ROM 上会被开机流程覆盖。

`c-set` 同时写 `config` 与 `system.prop`，并立即尝试运行时接口；vendor overlay
在下一次开机由 `post-fs-data` 重新生成。当前值同时兼容
`cmd wifi get-country-code` 与 `dumpsys wifi` 两种输出。

## 文件职责

| 路径 | 职责 |
|---|---|
| `module/module.prop` | 模块元数据（id / 版本 / 描述） |
| `module/config` | `CC`（国家码） |
| `module/post-fs-data.sh` | 开机：属性、vendor overlay、挂载 |
| `module/customize.sh` | 安装期权限与提示 |
| `module/uninstall.sh` | 卸载清理 |
| `module/user-hosts` | 唯一用户输入，由「保存并应用」写入 |
| `module/hosts` | 合并产物，页面生成 |
| `module/system/etc/hosts` | metamodule 路径的副本 |
| `module/system.prop` | 国家码属性，页面写入 |
| `module/webroot/index.html` | 页面结构、样式、交互、控制台、状态条 |
| `module/webroot/diag.js` | 数据层：解析、合并、采集、诊断 |
| `tests/` | Node 回归测试，不依赖设备 |

### 运行时文件（设备上）

| 文件 | 内容 |
|---|---|
| `mount.log` | 开机属性 / vendor overlay / 挂载结果 |
| `vendorcfg/` | 厂商 WLAN 配置的修改副本 |

页面不再写 `probe.log` / `diagnose.log` / `manager.log`：过程与结果都在控制台里。

## 不变量

改代码时不要破坏这几条：

1. 开机路径不联网、不采集、不等待网络
2. 检测只读；只有「保存并应用」会写 `user-hosts` 并挂载
3. `user-hosts` 是唯一输入；合并按域名去重且首条胜出
4. 页面不执行模块里的 `.sh`；所有命令都能在控制台看到
5. 所有挂载可重入；失败只记日志，不阻塞开机
6. 页面拿不到数据时显示“未知”，不用 0 或猜测填充
7. 构建不得修改仓库中的源文件（只在暂存副本里内联 `diag.js`）
