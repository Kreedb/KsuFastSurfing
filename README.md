# KsuFastSurfing · 极速冲浪

**KsuFastSurfing = 极速冲浪。** KernelSU / Magisk 模块：把 **hosts 加速**（FCM + GitHub）和 **WiFi 国家码** 放在同一个无系统改写的模块里。

纯脚本实现，不碰真实分区，卸载即恢复。

<p align="center">
  <code>Android 8+</code> · <code>KernelSU</code> · <code>Magisk</code> · <code>systemless</code>
</p>

> **关于命名**：项目曾用内部代号 `gcm-hosts-us`，只覆盖 FCM hosts + US 国家码，
> 无法承载后续新增的云端源、手动条目、任意国家码等功能，故更名为
> **KsuFastSurfing（极速冲浪）**，模块 id 同步改为 `KsuFastSurfing`。
> 从旧版升级请先卸载 `gcm-hosts-us` 再装新版 —— 模块 id 变了，
> 管理器不会把它们当作同一个模块，目录也会从 `/data/adb/modules/gcm-hosts-us`
> 变成 `/data/adb/modules/KsuFastSurfing`。

---

## 为什么做这个模块

国内网络环境下，两个问题经常同时出现，而它们各自都有「专门的模块」：

1. **FCM 推送延迟或收不到** —— `mtalk.google.com` 及其 `alt1-8` 备用域名被污染，Google 推送通道建不起来。
   表现是微信/Telegram/邮件推送延迟几分钟，或干脆不来。
2. **GitHub 访问慢** —— `github.com`、`raw.githubusercontent.com`、`codeload` 等域名解析到劣质 IP，克隆和下载卡住。

这两件事本质是同一个问题：**域名解析到了错误的 IP**，都靠 hosts 解决。
 第三个问题是 **WiFi 信道受限** —— 设备按错误的监管域（country code）工作，5GHz 的 149-165 信道、DFS 信道被屏蔽，明明路由器在广播却扫不到。

市面上有现成的 hosts 项目（本项目直接复用它们的成果），也有单独的 WiFi 国家码模块。
把它们收在一个模块里的理由很实际：**它们都是"开机时一次性改成正确状态"的静态配置**，
共享同一套挂载、日志、卸载清理逻辑，拆成三个模块只是让用户多刷三次、多三份重复代码。

### 一个必须先说清楚的取舍

KernelSU 从某一版起把 `/system` 挂载交给 **metamodule**（如 meta-overlayfs）负责。
也就是说：**只放一个 `module/system/etc/hosts`，如果用户没装 metamodule，它完全不会生效** ——
这是很多人自己写 hosts 模块后"刷了没反应"的根本原因。

所以本项目的主路径是 **bind mount**：在 `post-fs-data` 阶段把模块内的 `hosts` 挂到 `/system/etc/hosts`。
`module/system/etc/hosts` 仍然保留，作为装了 metamodule 时的备份路径。两条路喂的是同一份内容，不会打架。

---

## 设计思路

### 1. 分阶段执行，开机路径绝不联网

这是整个模块最重要的一条约束，其他设计都从它推出来。

`post-fs-data` 是 **阻塞式** 的，整个启动流程在等它，KernelSU 给的预算是 **10 秒**。
在里面下载 hosts 意味着：网络差的时候系统启动被拖慢，甚至触发看门狗。

于是职责被切成两半：

| 阶段 | 行为 | 是否联网 | 理由 |
|---|---|---|---|
| `post-fs-data.sh` | 合并本地快照 → 注入国家码属性 → 挂载 | **否** | 启动路径不能等网络 |
| `service.sh` | `boot_completed` 之后异步 `refresh` | 是 | 非阻塞，失败也不影响开机 |

代价是：**首次开机的 hosts 用的是随包发布的快照**，云端数据要等开机后才补上。
这是刻意的 —— 有可用快照时不联网，是比"每次开机都等一次网络"好得多的默认值。

### 2. 三层合并，用户永远优先

```
user-hosts  >  GitHub 加速  >  mtalk 加速
```

优先级不是靠"后写覆盖先写"实现的，因为 hosts 里同名域名的多行是未定义行为（取决于解析器）。
实现方式是**先占位再跳过**：先把 `user-hosts` 里的域名全部登记进去重表，
云端两层再逐条查表，已被占用的域名直接跳过。

这样用户写的 `5.6.7.8 github.com` 一定赢，且文件里不会出现两行同名记录。
实测：用户加这一行后，GitHub 层的条目数从 37 自动降到 36。

### 3. 下载必须校验，失败保留旧数据

代理不可靠 —— `gh-proxy.org` 可能返回限流页、错误页，甚至 200 状态的 HTML。
直接把响应体写成 hosts，结果就是整机 DNS 坏掉。

所以 `net_fetch` 的规则是：

- 先写临时文件，**校验通过才 `mv` 到位**（原子替换，不会出现半截文件）
- 校验标准：至少有一行形如「合法 IP + 至少一个域名」
- 校验失败 → 丢弃临时文件，**保留上一份缓存**
- 本地已有快照时，网络失败不影响可用性

### 4. 国家码双通道

只在 `service.sh` 里跑 `cmd wifi force-country-code` 是不够的 —— 它是**开机后**才生效，
而 WiFi 服务初始化时读的是属性。所以两条通道都写：

| 通道 | 时机 | 作用 |
|---|---|---|
| `system.prop` 里的 `ro.boot.wificountrycode` | 开机，KernelSU 加载 | 框架 / 厂商 HAL 在服务初始化时读 |
| `cmd wifi force-country-code enabled XX` | 开机后（含重试） | Android 10+ 官方运行时接口 |

两个值由同一处配置（`config` 的 `CC=`）驱动，`set-cc` 时同步写入，不会出现两处不一致。

### 5. 手动输入走 base64，不拼 shell 字符串

WebUI 的文本框内容要落到文件里，最直觉的做法是拼进 `echo '...' > user-hosts`。
但用户输入里可能有单引号、双引号、制表符、换行、中文 —— 任何一项都能让拼接出错甚至中断命令。

所以改成 `btoa` → `base64 -d`，字节能原样穿过 shell。
已用 `it's "quoted"`、tab、`::1`、中文做过字节级往返校验。

### 6. 所有状态可查，所有操作可重入

`manager.sh` 是唯一的控制面，子命令：

```
build     合并三层 → hosts
remount   重新 bind mount
refresh   下载 + build + remount + 应用国家码
apply     build + remount
set-cc XX 写 config / system.prop 并立即生效
regdom    只把国家码推给内核（iw reg set）
diagnose  四层信道诊断全量转储
cc-check  四层国家码/信道状态摘要
```

`post-fs-data` / `service` / `action` / WebUI 全部只是调它，没有第二份逻辑。
这意味着：任何时刻你都可以手动跑一次 `manager.sh refresh` 把状态修正，
不需要重启，也不需要理解某个具体脚本的内部状态。

### 7. 失败要留证据

三个日志，各自对应一个阶段：

```
/data/adb/modules/KsuFastSurfing/mount.log     挂载结果 + 校验结论
/data/adb/modules/KsuFastSurfing/service.log   开机后 refresh 的返回
/data/adb/modules/KsuFastSurfing/manager.log   下载、合并、国家码的每次尝试
```

不写日志的模块在真机上没法排障 —— 用户只能看到"没生效"，看不到"为什么"。

### 8. 卸载即恢复

`uninstall.sh` 做两件事：`umount` 掉挂载点，`cmd wifi force-country-code disabled` 把国家码交还给系统。
不留残余状态，是 systemless 模块的基本要求。

---

## 设计约定（后续开发请遵守）

这一节是给未来的自己（以及任何想改这个模块的人）的约束。新增功能时对照检查。

### 目录结构

```
KsuFastSurfing/
├── README.md            仓库说明 + 设计约定（本文件）
├── LICENSE              GPL-3.0
├── build.sh             打包脚本，产出 dist/<id>-<version>.zip
├── dist/                构建产物（不入库，KsuFastSurfing-vX.Y.zip）
├── tests/               回归测试（敌意 SSID / JSON 结构 / hosts 合并）
└── module/              模块本体，原样打进 zip 根目录
    ├── module.prop
    ├── config           运行配置（CC / USE_PROBED / PROBE_TIMEOUT / PROBE_THREADS）
    ├── manager.sh       唯一控制面
    ├── post-fs-data.sh  启动阶段：不联网
    ├── service.sh       开机后：异步刷新
    ├── action.sh        管理器「运行」按钮
    ├── uninstall.sh     清理
    ├── diagnose.sh      四层信道诊断（只读）
    ├── customize.sh     安装期权限设置
    ├── system.prop      国家码属性
    ├── hosts            合并产物（manager.sh build 生成）
    ├── probed-hosts     探测结果（运行期生成）
    ├── user-hosts       用户手动条目（最高优先级）
    ├── domains          参与探测的域名列表
    ├── probe.sh         本地 IP 探测（并发 + 超时）
    ├── wifidiag.sh      WiFi 诊断：采集 + 调度（薄壳）
    ├── wifidiag.awk     解析/分析/渲染，一趟输出 text 或 JSON
    ├── jsonlib.awk      JSON 字符串转义（按字节，gawk/busybox 一致）
    ├── system/etc/hosts metamodule 路径备份
    └── webroot/         WebUI
```

### 新增一个要探测的域名

只需在 `module/domains` 里加一行（`#` 注释可用），不必改脚本。
若某个域名需要指定候选 IP（本机 DNS 不返回或返回的不对），
再在 `probe.sh` 的 `dns_ips()` 里补一个兜底分支。

### 脚本规范

- **Shebang 一律 `#!/system/bin/sh`**，用 `busybox ash -n` 校验（不是 bash — Android 上没有 bash）
- **`MODDIR` 用 `case "$0" in */*) MODDIR=${0%/*} ;; *) MODDIR=. ;; esac`**
  而不是 `${0%/*}` —— 后者在 `sh manager.sh` 这种相对调用下会得到 `manager.sh`
- **不依赖 `curl`/`wget` 必然存在**，按 `curl → wget → busybox wget` 顺序降级
- **修改状态前先 `umount`**，挂载操作要幂等
- **所有写文件走「临时文件 + 校验 + mv」**，不做原地覆盖

### WebUI 规范

- **不要写 `import { exec } from 'kernelsu'`**
  该名字是 npm 包（`kernelsu`），必须先用 parcel/esbuild 打包成 bundle 才能用。
  静态 `index.html` 里直接 import，WebView 会抛
  `Failed to resolve module specifier "kernelsu"`，而且因为后续代码不执行，
  **所有状态显示为空、所有开关都是关闭状态** —— 看上去像"功能全坏了"，实际只是导入方式错了。
- 正确做法是直接调用管理器注入的全局对象（`WebViewInterface.kt` 里
  `webView.addJavascriptInterface(webviewInterface, "ksu")`）：

  ```js
  ksu.exec(cmd, JSON.stringify(options), callbackName)  // 同步返回，结果走回调
  // 之后管理器会以 javascript: URL 方式回调
  // callbackName(errno, stdout, stderr)
  ```

  需要 Promise 就自己包一层（见 `webroot/index.html` 的 `exec()` 实现），
  记得配一个超时兜底，否则桥断了 UI 会一直转圈。
- **模块路径不要硬编码**，用 `JSON.parse(ksu.moduleInfo()).moduleDir`。
  硬编码路径在项目改名（如本次 `gcm-hosts-us` → `KsuFastSurfing`）后会直接失效。
- 拿不到 `ksu` 时必须**降级成可读提示**（告诉用户用命令行），而不是抛异常或白屏。

### 配置与状态

- 运行配置只放 `config`（`KEY=VALUE` 一行一个），**不要**散落到多个文件
- `status` 输出必须保持 `key=value` + 每行一个的格式，WebUI 按行解析
- 状态里不要出现空格以外的分隔符，值里不要出现换行

### 打包

- 一律用 `./build.sh`，不要手工 `zip`
- 原因：`zip(1)` 在 Windows/部分环境不保留 POSIX 权限位，脚本到设备上会"不是可执行文件"
- `build.sh` 用 `zipfile` 显式写 `external_attr`，固定时间戳，保证**逐字节可复现**
- 运行期产物（`*.log`）不打包

### 提交前检查表

```sh
./build.sh                                   # 打包通过
for f in module/*.sh; do busybox ash -n "$f"; done   # 语法
sh tests/check-diag.sh                       # 诊断输出（敌意 SSID、JSON 结构）
./module/manager.sh build                    # 合并可用
awk '/^[0-9]/{print $2}' module/hosts | sort | uniq -d   # 无重复（应无输出）
```

---

## 功能

| 能力 | 说明 |
|---|---|
| 本地 IP 探测 | 本机 DNS 要候选 IP，TLS 握手测速，只留最快的一个 |
| 手动条目 | WebUI 编辑，IPv4/IPv6，`#` 注释，优先级最高 |
| 免写分区 | bind mount，`/system/etc/hosts` 原文件不动 |
| WiFi 国家码 | 默认 US，可改任意两位码，双通道生效 |
| WiFi 诊断 | 信道 / 干扰评分 / DFS / 网关丢包 / DNS，见下文 |
| WebUI | 四个选项卡：概览 / 信道 / hosts / 国家码 |
| 离线可用 | 开机只合并本地数据，不联网 |

### 本地 IP 探测（不再预置云端源）

早期版本随包内置两份云端 hosts 快照。实测这些 IP 有相当一部分在具体网络里
根本不通（TCP 能握手、TLS 被重置），预置数据反而会让人怀疑是模块坏了。

现在改为**在本机测量**：

1. 对 `module/domains` 里的每个域名，向本机 DNS 要候选 IP
2. 对每个 `(域名, IP)` 用 `curl --resolve` 做一次真实 TLS 握手，记录耗时
3. 每个域名保留耗时最短的那个，写入 `probed-hosts`
4. `user-hosts` 覆盖探测结果，最终合并成 `hosts`

参数可调（WebUI 或 `config`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `PROBE_TIMEOUT` | 3 | 单次握手超时（秒），1–20 |
| `PROBE_THREADS` | 8 | 并发数，1–32 |
| `USE_PROBED` | 1 | 是否启用探测结果 |

这带来一个直接好处：**开关飞行模式、换 SIM、换 Wi-Fi 之后重测一次即可**，
不需要等任何上游项目更新。

### 历史说明

早期版本曾内置 [yangFenTuoZi/fcm-hosts](https://github.com/yangFenTuoZi/fcm-hosts)
与 [maxiaof/github-hosts](https://github.com/maxiaof/github-hosts) 两个云端快照源。
它们已被本地探测取代，相关代码、`module/sources/` 与两个开关全部移除 ——
保留一半的兼容层只会让人以为还有云端依赖。

---

## 安装

1. 从 [Releases](../../releases) 下载 `KsuFastSurfing-vX.Y.zip`
2. KernelSU 管理器 → 模块 → 从本地安装 → 选择 zip
3. 重启

Magisk 同样适用（`cmd wifi` 需要 Android 10+）。

> 若你已装 meta-overlayfs 之类的 metamodule，`module/system/etc/hosts` 那条路也会生效，
> 但 bind mount 依然是主路径，两者内容相同。

## 使用

模块详情页 → 打开 WebUI。

- **概览**：当前链路（频率/信道/速率/信号）、周边频谱计数、建议信道、网关与 DNS
- **信道**：全部 AP 明细、DFS 专用统计
- **hosts**：探测条目数、手动条目、挂载状态；「探测并应用」按当前超时与线程数重测
- **国家码**：两位码（如 `US`/`CN`/`JP`）点「应用」；「恢复自动」交给系统判断

没有 WebUI 界面时也能用命令行：

```sh
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh status'
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh refresh'
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh set-cc JP'
```

## 配置

`module/config`：

```
CC=US            # WiFi 国家码，两位字母
USE_PROBED=1     # 1 启用本机探测结果
PROBE_TIMEOUT=2  # 单次 TLS 握手超时（秒），1-20
PROBE_THREADS=8  # 并发探测数，1-32
```

## 排障

先看日志，再看状态：

```sh
cat /data/adb/modules/KsuFastSurfing/mount.log     # 挂载是否成功
cat /data/adb/modules/KsuFastSurfing/manager.log   # 下载/合并/国家码
sh /data/adb/modules/KsuFastSurfing/manager.sh status
```

| 现象 | 常见原因 |
|---|---|
| `mounted=0` | 未重启；或 SELinux 阻止 bind mount（看 `mount.log`） |
| hosts 生效但没加速 | 运营商/DNS 走了 DoT/DoH，绕过 hosts |
| 国家码不生效 | 厂商 ROM 固定了 `ro.boot.wificountrycode`；或 `cmd wifi` 返回格式不同（看 `manager.log`） |
| 国家码生效但无信道 100–144 | `manager.sh cc-check`；若 `unii2c=no` 则是固件层硬限制，软件无解 |
| 探测结果为空 | 本机 DNS 解析不到候选 IP，或所有候选 TLS 握手都超时；调大 `PROBE_TIMEOUT` 重测 |
| `mounted=0` 且主机名解析正常 | 可能已由 metamodule 路径生效，`status` 以文件内容比对为准 |

## WiFi 诊断

模块的核心现在是一个诊断工具，hosts 只是它的一个旁支功能。

### 它测什么

| 指标 | 来源 | 说明 |
|---|---|---|
| 周边 AP 列表 | `cmd wifi list-scan-results` | 频率、信道、RSSI、安全类型 |
| 连接链路 | `cmd wifi status` 的 `WifiInfo` | 当前 SSID 的真实频率/速率/信号 |
| 频段分布 | 由频率推导 | 2.4G / 5G / 6G 各多少 |
| DFS 可见性 | 信道 52–64 / 100–144 | 这是判断能否用 ch100 的唯一硬证据 |
| 信道拥塞 | 每信道 BSSID 计数 | 找最干净的信道 |
| 信号质量 | RSSI 分级 | excellent / good / fair / weak |
| 干扰评分 | RSSI 换算成功率后加权求和 | 同信道全权重，±4 邻道 1/4 |
| 建议信道 | 干扰评分排序 | 见下节的两条排序规则 |
| 扫描新鲜度 | 扫描结果的 `Age` 列 | 框架会用缓存，这是唯一诚实的“数据新不新” |
| 网关 / 丢包 / RTT | `ip route` + `ping` 网关 | 区分“信号弱”和“AP 上行差” |
| DNS / 出网 | `ping <域名>` | 一次调用同时验证解析与可达 |
| 多 BSSID | 同 SSID 的 BSSID 计数 | 判断 mesh / 漫游环境 |

### 建议信道是怎么算的

单纯数“这个信道上几个 AP”会骗人：5 个 -80 dBm 的 AP 无所谓，1 个 -25 dBm 的
AP 就能毁掉整个信道。所以先按 `10^(rssi/10)` 把 dBm 换算成线性功率再求和，
同信道计全权重，±4 个信道（20 MHz 掩码重叠）计 1/4。

排序有两条容易踩的规则：

1. **DFS 一定要排在所有非 DFS 信道之后**，哪怕它干扰分数是 0。
   空 DFS 信道算术上最干净，却是最差的建议 —— 它只能被动扫描
   （发现慢、隐藏 SSID 永远看不到），还会因为雷达驱逐而断流。
   只按负载排序的话，工具会永远回答“ch 108”，数字没错但建议无用。
2. **同分时优先本次扫描里真实出现过的信道**，未扫描到的信道只是理论值，
   可能被射频层过滤掉了。

### 输出格式：JSON，不是分隔符

诊断结果有两条出口：`manager.sh wifi`（人读的 key=value 分段）和
`manager.sh wifi-json`（WebUI 读的 JSON）。**两者由同一次 awk 计算渲染**，
所以不会出现「网页和命令行的数字不一样」。

数据面必须是 JSON，原因不是时髦：

```c
/* 旧格式：ap SSID|freq|ch|rssi|age|dfs */
if (l.startsWith('ap ')) { const f = l.slice(3).split('|'); ... }
```

SSID 是邻居路由器起的名字，**可以包含 `|`、`=`、引号、反斜杠、空格**。
用 `|` 拼字段再用 `|` 拆，遇到这种 SSID 会让后面每一列错位。实测一个有
真实可能的 SSID `ap fake=1|2` 被解析成 `freq=2, ch=5745, rssi=149` ——
数字完全错误，界面却照常显示，没有任何报错。`=` 同理会影响 key=value 解析。

因此改为由 `wifidiag.awk` 一趟扫描直接输出 JSON，中间不存在可被破坏的文本编码。
`tests/check-diag.sh` 用含 `|`、`=`、`"`、`\`、中文的 SSID 做回归，busybox awk
与 gawk 各跑一遍。

顺带修掉两处：

- **SSID 必须转义再进 DOM**。SSID 由他人控制，直接拼进 `innerHTML` 会被
  `<img src=x onerror=...>` 这类名字注入。UI 里所有 SSID 走 `esc()`。
- **AWK 的数组键是字符串**。`for (c in cand)` 取出的 `c` 是 `"4"` 而不是 `4`，
  于是 `c > 34` 变成字典序比较（`"4" > "34"` 为真），2.4GHz 信道被错排到
  5GHz 前面。所有从数组键取出的数字都要 `+0`。

### 信道推荐的两条排序规则

1. **5GHz 整体排在 2.4GHz 之前**。2.4GHz 只有三个互不重叠的信道，
   且被周围所有设备共享，再"干净"也不如一个忙碌的 5GHz 信道。
2. **DFS 排在所有非 DFS 之后**，哪怕分数为 0。空 DFS 信道算术上最干净，
   却是最差的建议：只能被动扫描（隐藏 SSID 永远看不到），还会被雷达驱逐。

只按干扰分数排序时，参考数据上的答案恒为 `ch 108`（一个空 DFS 信道）——
算术没错，建议无用。

### busybox awk 没有数学函数

Android 的 toybox/busybox `awk` 是**不编译 math 支持**的，`10^1.5`、`log()`
直接报 `Math support is not compiled in`。所以功率换算用整数单位 + 循环连乘
实现（1 单位 = -100 dBm，每 0.5 dB 乘 1.122），既避开 `^`，又不会让
`%.2f` 把所有真实 AP 都打成 `0.00`。

### 为什么不用 `iw`

零售机型的 Android **不预装 `iw`**（荣耀 MagicOS 实测没有）。
用 `iw` 做诊断会在真机上得到一片 `unavailable`，看起来像工具坏了。
本工具全部走 `cmd wifi` 与 `dumpsys`，这两个在所有机型上都存在。

### 一个必须分清的区别

**「扫到了 ch100」≠「设置里能看到 ch100」。**

实测数据里出现过这样的情况：周边 46 个 AP，DFS 段扫到 7 个，
最强的一个就在 **5500 MHz（ch100）、-25 dBm**，而设置界面里依然看不到它。
原因是 DFS 信道默认**被动扫描**，且 UI 有独立的展示过滤。

所以判断顺序应该是：

1. 先看 `扫到 100-144` 是否为 0
2. 为 0 → 要么附近真没有 DFS AP，要么射频层过滤了
3. 不为 0 → 信道可用，UI 看不到属于展示/缓存问题，手动添加网络即可连

### 命令行

```sh
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh wifi'          # 采集+分析
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh wifi-json'     # JSON，给 WebUI 或脚本
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh wifi-api'      # 旧文本格式（兼容保留）
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh cc-check'      # 只看国家码相关
```

原始采集落在 `/data/adb/modules/KsuFastSurfing/diag/raw/`，
报告在 `diag/report.txt`，可以整份贴出来排障。

报告分段（`manager.sh wifi` 的输出）：

| 段 | 内容 |
|---|---|
| `[summary]` | AP 总数、2.4/5/6G 分布、DFS/UNII-3 计数、最强 AP |
| `[rf]` | 最强 AP 的 RSSI 与质量分级 |
| `[link]` | 已连接链路的频率/信道/速率/RSSI/标准/SSID |
| `[channel]` | 可见的 DFS 信道列表 |
| `[scan]` | 扫描缓存年龄与条目数 |
| `[score]` | 建议信道表：加权干扰、同信道数、邻道数 |
| `[roam]` | 同 SSID 多 BSSID 的统计 |
| `[congestion]` | 每信道 BSSID 计数（Top 12） |
| `[aps]` | 逐 AP 明细，按 RSSI 排序（Top 25） |
| `[net]` | 网关、丢包率、平均 RTT、DNS/出网 |
| `[verdict]` | 汇总结论：dfs / net / dns_l3 / best_ch |

`[verdict]` 里的 `net` 与 `dfs` 是两个独立维度：

- `net=ok` / `lossy` / `nogw` —— 网关层面
- `dfs=ok` / `none` / `nodata` —— 射频层面

“信号满格但上不了网”就是 `dfs=ok` + `net=lossy` 或 `dns_l3=fail`，
一眼能分清是 AP 上行烂还是 DNS 坏了。

## 5GHz / DFS 信道（重要）

**改了国家码仍然搜不到信道 100–144，通常不是模块没生效。**

信道 100–144 属于 **UNII-2C（5470–5725 MHz）**，在美国被划为 **DFS** 频段
（要与气象/军用雷达共存）。它受四层约束，而 `cmd wifi` 只能影响第一层：

| 层 | 谁在管 | 能否从 root 改 |
|---|---|---|
| 1. framework | WifiService / `cmd wifi` | 能（本模块已做） |
| 2. kernel regdb | cfg80211 / `iw reg set` | 能（本模块已做，但常被厂商驱动忽略） |
| 3. 驱动/固件 | 厂商 BDF / `WCNSS_qcom_cfg.ini` | 部分能（本模块尝试 overlay） |
| 4. 射频能力 | 硬件与固件实际支持的信道表 | **不能** |

判断卡在第几层，跑一条命令即可：

```sh
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh cc-check'
```

输出字段（`unii2a` / `unii2c` / `unii3` 是按**信道号**分桶的，不是按频率区间
—— 5725 MHz 正好是 ch149，用频率判定会把 UNII-3 算成 UNII-2C）：

```
framework=US     # 框架认为的国家码
kernel=00        # 内核 regdom（能读到才有），00 = 世界域，最常见的坏情况
bss5g=40         # 扫到的 5GHz AP 数
unii2c=1         # 扫到 ch100-144 的 AP 数，这是判断 DFS 能否使用的关键指标
unii2a=6         # 扫到 ch52-64 的 AP 数
unii3=20         # 扫到 ch149+ 的 AP 数
dfs_total=7      # 上两个 DFS 段之和
config=US        # 模块配置里写的值
```

若 `unii2c=0`，说明固件的信道表里压根没有 UNII-2C，
**没有任何国家码设置能让这些信道出现** —— 这是认证与射频能力的硬边界，不是软件开关。

完整四层转储（含 `iw reg get`、PHY 信道表、vendor ini）：

```sh
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh diagnose'
# 结果同时写入 /data/adb/modules/KsuFastSurfing/diagnose.log
```

### DFS 对被扫描方的额外限制

即便信道出现在表里，标了 `radar detection` 的信道**默认只能被动扫描**：
设备不主动发探测帧，只能等 AP 自己发信标。所以 DFS AP 的发现会明显偏慢，
或者"要等一会儿才出现"。如果 AP 隐藏了 SSID，被动扫描永远发现不了它 ——
这种情况只能手动添加网络（输入 SSID 与密码），手机才会去那个信道尝试关联。

## 已知限制

- 开机后第一次刷新是异步的，开机瞬间的 hosts 是上一次的结果
- `cmd wifi force-country-code` 的返回文案各厂商不同，重试判断基于错误关键词匹配，极端情况下可能误判成功
- 部分设备 vendor 层固定 WiFi 国家码，属性通道无效，只能靠 `cmd wifi`
- 极老设备 `/data` 就绪慢时，`post-fs-data` 的 5 秒等待窗口可能不够

## 开发

```sh
./build.sh
```

产物在 `dist/`，可直接刷入。改完请过一遍上面的「提交前检查表」。

## 许可

GPL-3.0，见 [LICENSE](LICENSE)。
