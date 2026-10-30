# KsuFastSurfing

**KernelSU / Magisk 模块：WiFi 诊断 · 可编辑并挂载的 hosts · 可配置 WiFi 国家码。**

WebUI 驱动，systemless：不写真实分区，卸载即恢复。模块里没有采集/控制脚本——
读取扫描、诊断、写 hosts、改国家码都由页面直接执行 Android 命令，每条命令与输出
都能在「控制台」选项卡里看到。

`Android 8+`（`cmd wifi` 相关功能需 Android 10+）· `KernelSU` · `Magisk`

---

## 它解决什么

1. **5GHz 信道用不上** —— 设备按错误的监管域工作，149-165 与 DFS 信道被屏蔽，路由器在广播却扫不到。
2. **hosts 写起来麻烦** —— 公共 hosts 里的 IP 对别人快、对你未必。模块只负责把你自己选的条目
   合并、写入并挂载，不做任何自动挑选；哪个地址快，由你在页面上自己填。
3. **信号满格却上不了网** —— 分不清是信号弱、AP 上行烂，还是 DNS 坏了。

三件事共用同一套挂载、日志与卸载逻辑，所以放在一个模块里。

## 功能

### WiFi 诊断

- 当前链路：SSID、频率 / 信道、速率、RSSI、Wi-Fi 标准
- 周边频谱：全部 AP 按网络名分组，同名多射频并排列出 BSSID / 信道 / 频率 / RSSI / 类型
- 信道建议：按线性功率加权的干扰分数，5GHz 优先、DFS 靠后
- DFS 可见性：UNII-2A / 2C / 3 分带计数，判断 ch100-144 是“扫不到”还是“UI 不显示”
- 链路质量：外网延迟（含 DNS 解析耗时）、出口 IP 与 DNS 及其归属地、DNS 判定，一次区分无线问题和上行问题

数据来自 `cmd wifi`、`dumpsys`、`ip route` / `ip addr` 与一次 HTTPS 回显请求，**不依赖 `iw`**（零售 ROM 通常没有）。

### hosts 编辑与挂载

- 一行一个 `IP 域名`，`#` 开头为注释；第一列必须是 IPv4 / IPv6，否则整行丢弃
- 合并按域名去重、**第一条胜出**，规则是纯 JS（`mergeHosts()`），有单元测试覆盖
- 写入 `user-hosts` 后同时生成两份 `hosts`（模块内 + `system/etc/hosts`），再 bind mount 到
  `/system/etc/hosts`
- 页面默认显示**设备上真正生效**的 `/system/etc/hosts`，点「编辑」才展开自己的草稿
- 不做域名探测、没有云端预置源，也没有“自动优化”

### WiFi 国家码

- 只调用 `cmd wifi force-country-code enabled XX`，随后 `get-country-code` 读回校验
- 不写属性、不改配置文件、不 overlay 厂商 ini：一个设置只留一个真相来源
- 代价是重启后回到系统判断，需要时在页面再点一次

## 界面

| 选项卡 | 内容 |
|---|---|
| 概览 | 当前链路、周边 AP 数、全信道干扰表（推荐信道标 ★）、外网延迟 / 出口 IP 与 DNS（带归属地）、按信号排序的 AP 明细、DFS 分带 |
| 网络配置 | hosts 条目数 / 挂载状态、只读视图 + 折叠编辑框、国家码应用 |
| 控制台 | 每条命令、退出码、耗时、输出摘要；清空 / 复制 |

页面配色与背景交给 KernelSU，不强制主题；所有操作反馈在底部全局状态条。

## 安装

1. 从 [Releases](https://github.com/Kreedb/KsuFastSurfing/releases) 下载 `KsuFastSurfing-vX.Y.zip`，
   或自行 `./build.sh` 构建（内置语法检查、单元测试与产物校验）
2. KernelSU / Magisk 管理器 → 模块 → 从本地安装
3. 重启

首次安装后 `user-hosts` 为空，hosts 只有 localhost；要加条目时打开 WebUI 编辑并保存。

## 快速开始

- **看信号**：概览页直接读当前链路与周边 AP 列表（按信号从强到弱）；扫描由系统负责，页面只读缓存并显示它的年龄
- **配 hosts**：网络配置页 →「编辑」→ 一行一个 `IP 域名` →「保存并应用」；不编辑时显示设备上实际生效的内容
- **改国家码**：网络配置页输入两位码 → 「应用」；「恢复自动」交还系统
- **查 DFS**：概览页看 UNII-2C 计数；为 0 说明固件信道表里就没有这一段

## 控制台

「控制台」选项卡是页面对设备的完整审计记录：

```
12:01:02.345  $ cmd wifi list-scan-results
12:01:03.120  → rc=0 · 775ms
12:01:03.121    BSSID  Frequency ...
                … 共 43 行 / 3204 字节
```

模块没有命令行入口：功能命令都由页面发出，控制台负责让它们可见。排障时先看这里，
开机记录看 `/data/adb/modules/KsuFastSurfing/mount.log`。

## 设计原则

- **全部 UI 驱动**：没有 `manager.sh` / `collect.sh` / `probe.sh` / `diagnose.sh` /
  `capacity.sh`；页面直接发命令、自己解析
- **开机不联网**：`post-fs-data` 只挂载上次保存的 hosts，10 秒预算内完成；不注属性、不 overlay
- **单一来源**：`user-hosts` 是唯一输入，合并时同名域名只保留第一条
- **不编造数据**：拿不到就显示“未获取 / 未知”，不用 0 或猜测填充

## 文档

| 文档 | 内容 |
|---|---|
| [docs/HANDOFF.md](docs/HANDOFF.md) | **接续开发先读**：当前状态、硬约束、验证结果、待办 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 运行架构、生命周期、控制面、文件职责 |
| [docs/WEBUI.md](docs/WEBUI.md) | 桥接协议、页面数据流、交互纪律、打包方式 |
| [docs/DIAGNOSTICS.md](docs/DIAGNOSTICS.md) | 扫描解析、信道 / DFS、干扰评分、L3、脱敏 BSSID |
| [docs/HOSTS.md](docs/HOSTS.md) | 编辑格式、合并去重规则、保存与挂载流程 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 构建、测试、脚本规范、Android 坑、发布纪律 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 按现象排查：挂载、MAC、国家码、页面 |
| [docs/README.md](docs/README.md) | 文档索引与推荐阅读顺序 |

## 兼容性

- Android 8+ 可安装；`cmd wifi`、`get-country-code` 需要 Android 10+
- KernelSU 与 Magisk 均可；依赖 root 执行 `cmd wifi` / `dumpsys` / `ip`
- 不假设 `iw`、`curl`、`wget` 存在，逐项降级
- 部分厂商 ROM 在 vendor / 固件层固定国家码，软件无法突破

## 许可

GPL-3.0，见 [LICENSE](LICENSE)。
