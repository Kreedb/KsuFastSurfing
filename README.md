# KsuFastSurfing

KernelSU / Magisk 模块：**WiFi 诊断** + **本机测速的 hosts 加速** + **可配置 WiFi 国家码**。
纯脚本 + 网页，不写真实分区，卸载即恢复。

`Android 8+` · `KernelSU` · `Magisk` · `systemless`

---

## 它解决什么

1. **5GHz 信道用不上** —— 设备按错误的监管域工作，149-165 与 DFS 信道被屏蔽，路由器在广播却扫不到。
2. **hosts 加速** —— `github.com`、`mtalk.google.com` 等域名解析到劣质 IP。模块在**本机**测哪些 IP
   真的能握手，而不是信任别人预置的清单。
3. **诊不明** —— 信号满格却上不了网时，分不清是信号弱、AP 上行烂、还是 DNS 坏了。

三件事共用同一套挂载、日志、卸载逻辑，所以放在一个模块里。

### 为什么用 bind mount 而不是只放 system 目录

KernelSU 把 `/system` 挂载交给 metamodule（如 meta-overlayfs）。**只放 `module/system/etc/hosts`，
用户没装 metamodule 就完全不生效** —— 这是自己写 hosts 模块后“刷了没反应”的常见原因。

所以主路径是在 `post-fs-data` 阶段 bind mount；`module/system/etc/hosts` 作为装了 metamodule 时的备份。
两条路喂同一份内容。

---

## 设计思路

### 开机路径绝不联网

`post-fs-data` 是阻塞式的，KernelSU 给 10 秒预算，联网会拖慢启动甚至触发看门狗。

| 阶段 | 行为 | 联网 |
|---|---|---|
| `post-fs-data.sh` | 合并本地数据 → 注入国家码属性 → 挂载 | 否 |
| `service.sh` | 开机后异步 `refresh`（探测 + 应用） | 是 |

代价是开机瞬间的 hosts 用的是上次探测结果，云端/网络数据在开机后补上。

### 用户永远优先

```
user-hosts  >  probed-hosts
```

不是“后写覆盖先写”——hosts 里同名域名的多行是未定义行为。实现是**先占位再跳过**：
先把 `user-hosts` 的域名登记进去重表，探测层逐条查表，已占用的跳过。
用户写 `5.6.7.8 github.com` 一定赢，且文件里不会出现两行同名。

### 国家码双通道

只在开机后跑 `cmd wifi force-country-code` 不够——WiFi 服务初始化时读的是属性。

| 通道 | 时机 | 作用 |
|---|---|---|
| `ro.boot.wificountrycode` 等属性 | 开机 | 框架 / 厂商 HAL 初始化时读 |
| `cmd wifi force-country-code enabled XX` | 开机后 | Android 10+ 官方运行时接口 |

两者由 `config` 的 `CC=` 驱动，`set-cc` 时同步写入。

### 手动输入走 base64

文本框内容落到文件时如果拼 shell 字符串，用户输入里的引号、制表符、中文都能让拼接出错。
改为 `btoa` → `base64 -d`，字节能原样穿过 shell。

### 所有状态可查，所有操作可重入

`manager.sh` 是唯一控制面，`post-fs-data` / `service` / `action` / 命令行都只是调它。
任何时刻都能手动跑一次把状态修正，不必重启。

---

## WebUI

数据由**页面自己**读取和解析（`webroot/diag.js`，构建时内联进 `index.html`）。
WebUI 桥以 root 执行命令，所以页面可以直接用：

```
cmd wifi list-scan-results   →  AP 列表
cmd wifi status              →  当前链路
ip route + ping              →  网关 / 丢包 / RTT / DNS
```

这样不依赖设备上的 `awk`，也没有中间文件需要同步，屏幕上是刚测到的数据。
`wifidiag.sh` 仍保留给命令行使用。

### 界面

- 配色与背景交给 KernelSU，页面不设 `color-scheme` 也不设背景色，跟随管理器主题
- 底部**全局状态条**：任何选项卡的操作都反馈在这里（运行中带进度条、完成/失败带颜色）
- 四个选项卡：概览 / 信道 / hosts / 国家码

### 数据解析的硬约束

SSID 是邻居路由器起的名字，**可以包含 `|`、`=`、引号、反斜杠、空格**。
**永远不要**用分隔符拼接再拆分字段：实测一个 `ap fake=1|2` 会被解析成
`freq=2, ch=5745, rssi=149`——数字全错，页面照常显示，不报错。

正确做法（已实现）：SSID 取「age 列之后到第一个 `[` 之前」的整段文本。
SSID 进 DOM 前必须走 `esc()`，否则 `<img src=x onerror=...>` 这类名字会在 WebView 里执行。

### Channel 推荐的两条排序规则

1. **5GHz 整体排在 2.4GHz 之前**。2.4GHz 只有三个不重叠信道且被周围所有设备共享。
2. **DFS 排在所有非 DFS 之后**，哪怕分数为 0。空 DFS 信道只能被动扫描、会被雷达驱逐，
   是最差的建议。只按负载排序时，实测数据上的答案恒为 `ch 108`（空 DFS）——算术没错，建议无用。

干扰分数：RSSI 换算成线性功率后求和，同信道全权重、±4 邻道 1/4。
候选信道只能来自标准栅格 + 实际观测到的信道——±4 扩散会产出 ch45/46/50 这类不存在的信道。

### 状态条不能被子流程覆盖

`refreshAll()` 会重读状态，它**不能自己写状态条**：它由 `busy()` 的 finally 调用，
一写就会把刚完成的操作结果冲掉（`探测完成：5/12` 变成 `就绪`）。
启动流程也有 `userActed` 守卫，用户点过按钮后就不再输出「就绪」。

---

## 安装

1. 下载 `KsuFastSurfing-vX.Y.zip`
2. KernelSU 管理器 → 模块 → 从本地安装
3. 重启

Magisk 同样适用（`cmd wifi` 需要 Android 10+）。

## 使用

模块详情页 → 打开 WebUI。

- **概览**：当前链路（频率/信道/速率/信号）、周边频谱、建议信道、网关与 DNS
- **信道**：全部 AP 明细、DFS 分带（UNII-2A / 2C / 3）
- **hosts**：探测条目、手动条目、挂载状态；「探测并应用」按当前超时与线程重测
- **国家码**：两位码点「应用」；「恢复自动」交还系统

命令行：

```sh
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh status'
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh wifi'          # 诊断（文本）
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh refresh'       # 探测 + 应用
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh set-cc JP'
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh cc-check'      # 国家码四层摘要
```

## 配置

`module/config`：

```
CC=US            # WiFi 国家码，两位字母
USE_PROBED=1     # 1 启用本机探测结果
PROBE_TIMEOUT=3  # 单次 TLS 握手超时（秒），1-20
PROBE_THREADS=8  # 并发探测数，1-32
```

探测的域名列表在 `module/domains`，一行一个，`#` 注释。加域名不必改脚本。

## WiFi 诊断

| 指标 | 说明 |
|---|---|
| 周边 AP | 频率、信道、RSSI、安全类型 |
| 连接链路 | 当前 SSID 的真实频率/速率/信号 |
| DFS 可见性 | ch100-144 的 AP 数，判断能否用 ch100 的硬证据 |
| 干扰评分 | 线性功率加权，同信道全权重、±4 邻道 1/4 |
| 扫描新鲜度 | 结果的 `Age` 列，框架会复用缓存 |
| 网关 / 丢包 / RTT | 区分「信号弱」与「AP 上行差」 |
| DNS / 出网 | 一次 lookup 同时验证解析与可达 |
| 多 BSSID | 同 SSID 的 BSSID 数，判断 mesh / 漫游 |

### 为什么不用 `iw`

零售机型的 Android **不预装 `iw`**（荣耀 MagicOS 实测没有）。用 `iw` 做诊断会得到一片
`unavailable`，看起来像工具坏了。全部走 `cmd wifi` 与 `dumpsys`，这两个都在。

### 「扫到 ch100」≠「设置里能看到 ch100」

实测：周边 46 个 AP，DFS 段扫到 7 个，最强的一个就在 **5500 MHz（ch100）、-25 dBm**，
设置界面里依然看不到。原因是 DFS 信道默认**被动扫描**，且 UI 有独立的展示过滤。

判断顺序：先看扫到的 100-144 是否为 0；为 0 则射频层过滤或附近真没有；
不为 0 则信道可用，UI 看不到属于展示/缓存问题，手动添加网络即可连。

---

## 5GHz / DFS 信道

**改了国家码仍搜不到 100-144，通常不是模块没生效。**

ch100-144 属 **UNII-2C（5470-5725 MHz）**，在美国是 DFS 频段（与雷达共存）。
它受四层约束，`cmd wifi` 只能影响第一层：

| 层 | 谁在管 | 能否从 root 改 |
|---|---|---|
| framework | WifiService / `cmd wifi` | 能（本模块已做） |
| kernel regdb | cfg80211 / `iw reg set` | 能（本模块已做，常被厂商驱动忽略） |
| 驱动/固件 | 厂商 BDF / `WCNSS_qcom_cfg.ini` | 部分能（本模块尝试 overlay） |
| 射频能力 | 硬件与固件实际支持的信道表 | **不能** |

```sh
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh cc-check'
```

字段（`unii2a` / `unii2c` / `unii3` 按**信道号**分桶，不是频率区间——
5725 MHz 正好是 ch149，用频率判定会把 UNII-3 算成 UNII-2C）：

```
framework=US     # 框架认为的国家码
kernel=00        # 内核 regdom（能读到才有），00 = 世界域，最常见的坏情况
bss5g=40         # 扫到的 5GHz AP 数
unii2c=1         # 扫到 ch100-144 的 AP 数，判断 DFS 的关键指标
unii2a=6         # 扫到 ch52-64 的 AP 数
unii3=20         # 扫到 ch149+ 的 AP 数
dfs_total=7      # 上两个 DFS 段之和
config=US        # 模块配置
```

若 `unii2c=0`，说明固件信道表里没有 UNII-2C，**没有任何国家码设置能让它出现**。

完整四层转储（含 `iw reg get`、PHY 信道表、vendor ini）：

```sh
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh diagnose'
# 同时写入 diagnose.log
```

### DFS 的额外限制

即使信道在表里，标了 `radar detection` 的信道**默认只能被动扫描**：设备不发探测帧，
只能等 AP 发信标。所以 DFS AP 发现偏慢。若 AP 隐藏了 SSID，被动扫描永远发现不了，
只能手动添加网络。

---

## 排障

```sh
cat /data/adb/modules/KsuFastSurfing/mount.log     # 挂载结果
cat /data/adb/modules/KsuFastSurfing/manager.log   # 合并 / 国家码
cat /data/adb/modules/KsuFastSurfing/probe.log     # 探测
sh /data/adb/modules/KsuFastSurfing/manager.sh status
```

| 现象 | 常见原因 |
|---|---|
| `mounted=0` | 未重启；或 SELinux 阻止 bind mount（看 `mount.log`） |
| hosts 生效但没加速 | 运营商/DNS 走了 DoT/DoH，绕过 hosts |
| 探测结果为空 | 本机 DNS 解析不到，或候选全部握手超时；调大 `PROBE_TIMEOUT` |
| 国家码不生效 | 厂商 ROM 固定在 vendor 层；看 `manager.log` 的 `cmd wifi` 返回 |
| 国家码生效但无 ch100-144 | `cc-check`；`unii2c=0` 则是固件硬限制，软件无解 |

## 已知限制

- 开机后第一次刷新是异步的，开机瞬间的 hosts 是上次结果
- `cmd wifi force-country-code` 的返回文案各厂商不同，重试判断靠关键词匹配
- 部分设备 vendor 层固定国家码，属性通道无效，只能靠 `cmd wifi`
- 极老设备 `/data` 就绪慢时，`post-fs-data` 的等待窗口可能不够

---

## 开发

```sh
./build.sh              # 打包到 dist/，同时把 diag.js 内联进 index.html
node tests/test-diag.js # 网页解析器：敌意 SSID、RSSI 格式、UNII、推荐规则
sh tests/check-diag.sh  # 命令行诊断输出
```

提交前检查：

```sh
./build.sh
for f in module/*.sh; do busybox ash -n "$f"; done
node tests/test-diag.js
sh tests/check-diag.sh
./module/manager.sh build
awk '/^[0-9]/{print $2}' module/hosts | sort | uniq -d   # 无输出
```

### 目录

```
KsuFastSurfing/
├── build.sh             打包（显式写 POSIX 权限位，逐字节可复现）
├── tests/               回归测试
├── dist/                构建产物（不入库）
└── module/
    ├── module.prop       模块元数据
    ├── config            运行配置
    ├── manager.sh        唯一控制面
    ├── post-fs-data.sh   启动：不联网
    ├── service.sh        开机后：异步刷新
    ├── action.sh         管理器「运行」按钮
    ├── uninstall.sh      清理
    ├── customize.sh      安装期权限
    ├── diagnose.sh       四层信道诊断（只读）
    ├── probe.sh          本机 IP 探测（并发 + 超时）
    ├── wifidiag.sh       诊断入口（命令行）
    ├── wifidiag.awk      解析/分析/渲染（命令行文本）
    ├── jsonlib.awk       JSON 转义（按字节，gawk/busybox 一致）
    ├── domains           待探测域名列表
    ├── hosts             合并产物（manager.sh build 生成）
    ├── user-hosts        手动条目（最高优先级）
    ├── system.prop       国家码属性
    ├── system/etc/hosts  metamodule 路径备份
    └── webroot/
        ├── index.html    WebUI（自包含）
        └── diag.js       数据层：读接口 + 解析 + 分析
```

### 脚本规范

- Shebang 一律 `#!/system/bin/sh`，用 `busybox ash -n` 校验（Android 上没有 bash）
- `MODDIR` 用 `case "$0" in */*) MODDIR=${0%/*} ;; *) MODDIR=. ;; esac`
  —— `${0%/*}` 在 `sh manager.sh` 这种相对调用下会得到 `manager.sh`
- 不依赖 `curl`/`wget` 必然存在，按 `curl → wget → busybox wget` 降级
- 修改状态前先 `umount`，挂载要幂等
- 写文件走「临时文件 + 校验 + mv」，不做原地覆盖

### 不要指望 Android 的 awk 和桌面上的一样

真机上已经踩过三次：

| 差异 | 表现 |
|---|---|
| 没有 `strftime` | `awk: calling undefined function strftime`，整个报告中止 |
| 没有数学函数 | `Math support is not compiled in`，`10^x`、`log()` 直接失败 |
| `gsub` 反斜杠不同 | 同样写法 gawk 输出 `\"`，busybox 输出裸 `"` |

所以：时间戳由 `date` 生成后用 `-v ts=` 传入；功率换算用整数单位连乘；
JSON 转义逐字节循环。写新 awk 前先在 `busybox awk` 下跑一遍。

### WebUI 规范

- **不要写 `import { exec } from 'kernelsu'`**。该名字是 npm 包，静态页面里 import 会抛
  `Failed to resolve module specifier`，且因后续代码不执行，**所有状态为空、开关全关**
- 正确做法是调管理器注入的全局对象：`ksu.exec(cmd, optsJson, callbackName)`
- 模块路径用 `JSON.parse(ksu.moduleInfo()).moduleDir`，不要硬编码
- 拿不到 `ksu` 时降级成可读提示
- 不设页面背景与 `color-scheme`，交给 KernelSU
- `index.html` 必须自包含（`diag.js` 构建时内联），WebView 对相对路径 `<script src>` 不可靠

## 许可

GPL-3.0，见 [LICENSE](LICENSE)。