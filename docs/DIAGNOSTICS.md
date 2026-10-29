# WiFi 诊断

## 数据从哪来

`collect.sh` 一次执行四条命令，页面按段解析：

| 段 | 命令 | 用途 |
|---|---|---|
| `##scan` | `cmd wifi list-scan-results` | 周边 AP：BSSID / 频率 / RSSI / Age / SSID / Flags |
| `##link` | `cmd wifi status` | 当前连接的 SSID、频率、速率、RSSI、标准 |
| `##route` | `ip route` | 默认网关与出口接口 |
| `##ping` | `ping -c 3 -i 0.2 -W 1 <网关>` | 丢包与平均 RTT |
| `##dns` | `ping -c 1 -W 1 github.com` 的返回码 | 解析 + 出网是否通 |
| `##mac` | `wpa_cli scan_results` | 还原被框架脱敏的 BSSID |

**不依赖 `iw`**。零售机型的 Android 不预装它（荣耀 MagicOS 实测没有），
用 `iw` 做诊断会得到一片 `unavailable`，看起来像工具坏了。全部走 `cmd wifi`
与 `dumpsys`，这两个是系统自带的。

## 扫描行解析

`cmd wifi list-scan-results` 的一行形如：

```
  aa:bb:**:**:ee:01  5180  -51(0:-51/1:-56)  7.5  My WiFi  [RSN-PSK][ESS]
```

解析顺序：

1. 跳过表头与空行
2. 正则取出 BSSID、频率、主 RSSI、Age、剩余文本
3. 剩余文本里**第一个 `[` 之前**的全部内容是 SSID，`[` 之后是 Flags
4. SSID 为字面量 `null` 时视为隐藏
5. `freq < 2400` 的行丢弃（不是 WiFi 频段）

### 为什么不能按分隔符拆字段

SSID 是邻居路由器起的名字，可以包含 `|`、`=`、引号、反斜杠、空格。
用分隔符拼接再拆字段，实测一个 `ap fake=1|2` 会被解析成 `freq=2, ch=5745, rssi=149`：
数字全错，页面照常显示，不报错。

正确做法就是上面第 3 步：以 `[` 为界，SSID 取整段文本。SSID 进 DOM 前必须 `esc()`。

### 频段与信道

```js
ch = f <= 2500 ? (f === 2484 ? 14 : floor((f - 2407) / 5))
   : f <= 5895 ? floor((f - 5000) / 5)
   :             floor((f - 5950) / 5)
```

- 2.4GHz：2407-2484 MHz
- 5GHz：5000-5895 MHz，5 MHz 栅格
- 6GHz：5950 MHz 起

### 安全类型

按 Flags 里的关键词判定，同一 SSID 的不同射频可以不同：

| Flags 含 | 显示 |
|---|---|
| `SAE` | WPA3 |
| `RSN` | WPA2 |
| `WPA` | WPA |
| 都没有 | 开放 |

## 链路与 L3

`cmd wifi status` 只有一行 `WifiInfo:`。字段逗号分隔，但 SSID 带引号，
所以用 `SSID:\s*"([^"]*)"` 取，避免 SSID 里的逗号把字段切断。

`parseNet` 是纯函数，输入是已经采集好的 route / ping / dns 三段：

- 网关：`default via <ip>`；没有默认路由时为空，不猜
- 丢包：`N% packet loss`
- RTT：`rtt ... = min/avg/max` 取 **avg**，不是 max
- DNS：`rc=0` 为正常，非 0 为失败，缺段为未知

三段独立解析，所以 ping 失败不会把网关清空，网关缺失也不会显示成 0% 丢包。

## 信道模型

### UNII 分带按信道号，不按频率

```js
isDfs(c) = (c >= 52 && c <= 64) || (c >= 100 && c <= 144)
uniiOf(c) = c < 36 ? '-' : c <= 64 ? 'UNII-2A' : c <= 144 ? 'UNII-2C' : 'UNII-3'
```

5725 MHz 正好是 ch149（UNII-3）。用频率区间判定会把 ch149 算进 UNII-2C，
所以分桶一律用信道号。

### 干扰分数

按 AP 数量排序会撒谎：五个 -80 dBm 的 AP 不如一个 -25 dBm 的 AP 吵。

```
power = 10^(rssi / 10)
同信道：全权重
±1..4 信道：1/4 权重（20MHz 掩码重叠）
```

RSSI 是 dBm，先换成线性功率再求和；对数和没有物理意义。

### 候选信道

只能来自：

- 实际观测到的信道
- 2.4GHz 的 1-13
- 5GHz 的标准栅格：36-64、100-144、149-165，步长 4

**不能**直接用负载表的 key：±4 扩散会产出 ch45、ch46、ch50 这类不存在的信道
（5GHz 信道间隔是 4），实测因此推荐过 ch49。

### 排序规则

1. **5GHz 先于 2.4GHz**：2.4GHz 只有三个不重叠信道，且被周围所有设备共享；
   一个“干净”的 ch1 也不如一个忙碌的 5GHz 信道
2. **非 DFS 先于 DFS**：空 DFS 信道分数为 0，但只能被动扫描、会被雷达驱逐，
   是最差的建议。只按负载排序时，实测答案恒为 ch108（空 DFS）——算术没错，建议无用
3. 负载低的优先
4. 实际观测到的信道优先
5. 信道号小的优先（稳定排序，避免每次刷新顺序抖动）

## 扫描新鲜度

框架会复用扫描缓存，`Age(sec)` 是每条结果的年龄。页面用两个值：

- `ageMed`：中位数，描述整份缓存的新旧
- `ageMin`：最小值，证明“这次扫描真的回来了新结果”

**不用最大值**：最大值由缓存里最旧的一条决定，扫描落地时几乎不变，
按钮看起来像没反应。

重新扫描的流程是 `cmd wifi start-scan` 后轮询 `collect.sh scan`，
间隔 400 / 600 / 800 / 1000×6 ms，用 age 最小值是否下降（阈值 1 秒）判断新鲜度。
中位数用于描述整份缓存的新旧，不作为“是否扫到新结果”的判据。

## BSSID 脱敏与恢复

Android 12+ 把框架返回的 BSSID 第 3、4 段抹成 `**`：

```
68:19:**:**:37:c3
```

页面以 root 运行，`collect.sh` 在**检测到 `**` 时**才读 `wpa_supplicant` 的
`scan_results`，用保留的前两段与后两段匹配：

- 同频率 + 前缀后缀吻合 → 唯一候选
- 多个候选 → 取 RSSI 最接近的（同频同前缀时的取舍）
- 没有吻合 → 同频最近的一个，差距超过 6 dB 放弃
- 拿不到 `wpa_cli` → 保留脱敏值，**不编造**

socket 目录依次探测：

```
/data/vendor/wifi/wpa/sockets
/data/misc/wifi/sockets
/data/vendor/wifi/sockets
```

读不到结果时触发一次 `wpa_cli scan`，按 0.2 / 0.4 / 0.8 s 退避重读，最坏 1.4 s。
旧版本在三个目录上各 `sleep 2` 两次，即使设备没有 `wpa_cli` 也要付 8 秒。

### 顺带修 SSID

框架的 SSID 列会补空格并按字节截断，截断点落在多字节字符中间时，中文名会变成
“首字 + 替换符”。`scan_results` 是原始字节，两者不一致时优先用它。

## DFS 与「扫到 ch100」

### 四层约束

ch100-144 属 **UNII-2C（5470-5725 MHz）**，在美国与 UNII-2A（52-64）一样是 DFS 频段
（与雷达共存）。它受四层约束，`cmd wifi` 只能影响第一层：

| 层 | 谁在管 | 能否从 root 改 |
|---|---|---|
| framework | WifiService / `cmd wifi` | 能（本模块已做） |
| kernel regdb | cfg80211 / `iw reg set` | 能（本模块已做，常被厂商驱动忽略） |
| 驱动 / 固件 | 厂商 BDF / `WCNSS_qcom_cfg.ini` | 部分能（本模块尝试 overlay） |
| 射频能力 | 硬件与固件实际支持的信道表 | **不能** |

### 「扫到 ch100」≠「设置里能看到 ch100」

实测：周边 46 个 AP，DFS 段扫到 7 个，最强的一个就在 **5500 MHz（ch100）、-25 dBm**，
设置界面里依然看不到。原因是 DFS 信道默认**被动扫描**，且 UI 有独立的展示过滤。

判断顺序：

1. 扫到的 100-144 为 0 → 射频层过滤，或附近真没有
2. 不为 0 → 信道可用；UI 看不到属于展示 / 缓存问题，手动添加网络即可连

命令行等价输出：

```sh
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh diagnose'
```

看 `bss_unii2c`：为 0 说明固件信道表里没有 UNII-2C，**没有任何国家码设置能让它出现**。

### 被动扫描的额外限制

即使信道在表里，标了 `radar detection` 的信道默认只能被动扫描：设备不发探测帧，
只能等 AP 发信标。所以 DFS AP 发现偏慢。若 AP 隐藏了 SSID，被动扫描永远发现不了，
只能手动添加网络。

## 按 SSID 分组

同一个网络名常由多个射频提供（mesh、中继、路由器的 2.4G 与 5G 同名）。
信道页按 SSID 分组，组内按 RSSI、信道排序，组间按最强成员排序：

```
        My WiFi
aa:bb:cc:dd:ee:01   36   5180   -48   UNII-2A
aa:bb:cc:dd:ee:02   6    2437   -61   普通
```

这样同名 AP 的 BSSID、频段、信号一眼可见，不需要展开或翻页。

## 硬件能力

`capacity.sh` 让设备自己回答三件事：

| 项 | 前提 | 常见结果 |
|---|---|---|
| `survey` | 驱动实现 `NL80211_CMD_GET_SURVEY` | 高通 `qcacld` 多半没有，`iw survey dump` 为空 |
| `monitor` | 支持监听模式 | 原厂固件通常关闭 |
| `injection` | 监听模式 + 固件允许注入 | 原厂固件一律关闭 |

```sh
su -c 'sh /data/adb/modules/KsuFastSurfing/manager.sh capacity'
```

WebUI 的「硬件能力」卡片调同一个脚本。三项都是“不支持”时，就不必往频谱仪 /
deauth 方向投入；`monitor=yes` 但 `monitor_creatable=no` 说明驱动声明了却没实现，
这类“看起来能做”比直接不支持更容易浪费时间，页面单独标红。

### 频谱仪与 deauth 的可行性

结论：**内置射频做不了频谱仪，也做不了 deauth**。不是代码量问题，是硬件前提。

| 能力 | 前提 | 手机内置芯片 |
|---|---|---|
| 噪声 / 信道占用 | 驱动实现 survey | 多半没有 |
| 频谱曲线 | 监听模式 + 逐帧 RSSI | 无监听模式，且逐帧 RSSI 不是扫频功率 |
| deauth / 帧注入 | 监听模式 + 固件允许注入 | 原厂固件关闭，需打补丁或外接网卡 |

区分三个常被混为一谈的东西：

1. **每 AP 的 RSSI**（本模块已有）：每个网络一个数，不构成频谱，也看不到非 WiFi 干扰源
2. **survey 的 channel busy time**：时间占比，不是功率；做不了瀑布图，但能回答
   “哪个信道被占得最厉害”，比按 AP 数估算准
3. **真正的频谱仪**：每 MHz 的功率曲线，需要监听模式逐包取 RSSI，或外接 SDR

`iw` 在零售 ROM 上不存在，所以本项目不假设它可用：能查的只有
`/sys/kernel/debug/ieee80211/` 下驱动暴露的节点，和 `wpa_cli signal_poll` 的 `NOISE=`。
两者都拿不到时，结论是“未确认”，不是“支持”。

关于 deauth：即便硬件支持，本模块也不会实现。抓包注入是在别人的网络上主动干扰，
与“测量自己链路的状况”是两件事。
