# KsuFastSurfing

**KernelSU / Magisk 模块：WiFi 诊断 · 本机实测的 hosts 加速 · 可配置 WiFi 国家码。**

WebUI 驱动，systemless：不写真实分区，卸载即恢复。模块里没有采集/控制脚本——
读取扫描、诊断、写 hosts、改国家码都由页面直接执行 Android 命令，每条命令与输出
都能在「控制台」选项卡里看到。

`Android 8+`（`cmd wifi` 相关功能需 Android 10+）· `KernelSU` · `Magisk`

---

## 它解决什么

1. **5GHz 信道用不上** —— 设备按错误的监管域工作，149-165 与 DFS 信道被屏蔽，路由器在广播却扫不到。
2. **hosts 加速靠玄学** —— 公共 hosts 里的 IP 对别人快、对你未必。本模块在**本机**逐个测哪些 IP
   真的能完成 TLS 握手，再把最快的一个写进 hosts。
3. **信号满格却上不了网** —— 分不清是信号弱、AP 上行烂，还是 DNS 坏了。

三件事共用同一套挂载、日志与卸载逻辑，所以放在一个模块里。

## 功能

### WiFi 诊断

- 当前链路：SSID、频率 / 信道、速率、RSSI、Wi-Fi 标准
- 周边频谱：全部 AP 按网络名分组，同名多射频并排列出 BSSID / 信道 / 频率 / RSSI / 类型
- 信道建议：按线性功率加权的干扰分数，5GHz 优先、DFS 靠后
- DFS 可见性：UNII-2A / 2C / 3 分带计数，判断 ch100-144 是“扫不到”还是“UI 不显示”
- 链路质量：网关、丢包、RTT、出口 IP 与 DNS 判定，一次区分无线问题和上行问题

数据来自 `cmd wifi`、`dumpsys`、`ip route`、`ping` 与 `/proc` / `/sys`，**不依赖 `iw`**（零售 ROM 通常没有）。

### hosts 加速

- 域名列表在 `module/domains`，一行一个，可自行增删
- 解析走短路链：`ping` → `getent` / `nslookup` → DoH（Cloudflare → Google），拿到即停
- 可达性看 `time_connect` 与 TLS 握手，不看 HTTP 状态码；403 同样证明链路是通的
- 每个域名留最快的一个 IP，结果**只追加到编辑框**，用户确认后按「保存并应用」才生效
- 没有云端预置源，没有后台探测，没有“自动优化”

### WiFi 国家码

- 开机注入 `ro.boot.wificountrycode` 等属性，供框架 / 厂商 HAL 初始化时读取
- 应用国家码时调用 `cmd wifi force-country-code`，覆盖 Android 10+ 的运行时接口
- 对高通平台尝试 overlay `/vendor/etc/wifi/WCNSS_qcom_cfg.ini` 的 `gStaCountryCode`

## 界面

| 选项卡 | 内容 |
|---|---|
| 概览 | 当前链路、周边 AP 数、全信道干扰表（推荐信道标 ★）、网关 / 丢包 / 出口 DNS、按信号排序的 AP 明细、DFS 分带 |
| 网络配置 | hosts 条目数 / 挂载状态、只读视图 + 折叠编辑框、国家码应用 |
| 控制台 | 每条命令、退出码、耗时、输出摘要；清空 / 复制 |

页面配色与背景交给 KernelSU，不强制主题；所有操作反馈在底部全局状态条。

## 安装

1. 从 [Releases](https://github.com/Kreedb/KsuFastSurfing/releases) 下载 `KsuFastSurfing-vX.Y.zip`，
   或自行 `./build.sh` 构建（内置语法检查、单元测试与产物校验）
2. KernelSU / Magisk 管理器 → 模块 → 从本地安装
3. 重启

首次安装后 `user-hosts` 为空，hosts 只有 localhost；需要加速时打开 WebUI 填条目并保存。

## 快速开始

- **看信号**：概览页直接读当前链路与周边 AP 列表（按信号从强到弱）；扫描由系统负责，页面只读缓存并显示它的年龄
- **配 hosts**：hosts 页 →「编辑」→ 一行一个 `IP 域名` →「保存并应用」；不编辑时显示设备上实际生效的内容
- **改国家码**：国家码页输入两位码 → 「应用」；「恢复自动」交还系统
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
- **开机不联网**：`post-fs-data` 只做属性注入、vendor overlay 与挂载上次保存的 hosts，
  10 秒预算内完成
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
