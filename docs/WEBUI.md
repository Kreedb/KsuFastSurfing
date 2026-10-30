# WebUI

页面是纯静态 HTML，无框架、无构建期依赖。`index.html` 负责结构、样式、交互与控制台；
`diag.js` 负责解析、合并、采集与诊断。打包时把 `diag.js` 内联进
`dist` 副本，仓库里两者保持分离。

**页面是唯一的控制面。** 模块里没有 `manager.sh` / `collect.sh` / `probe.sh` /
`diagnose.sh` / `capacity.sh`，页面通过 `ksu.exec` 直接执行 Android 原生命令，
自己解析输出、自己写文件。

## 桥接协议

KernelSU 只向页面注入一个全局对象 `ksu`：

```js
ksu.exec(cmd, JSON.stringify(options), callbackName)
```

- `callbackName` 是**字符串**，不是函数；页面必须先把回调挂到 `window[callbackName]`
- 回调签名 `(errno, stdout, stderr)`
- **不要**写 `import { exec } from 'kernelsu'`：那是 npm 包，静态页面里会抛
  `Failed to resolve module specifier`，且后续代码不执行，表现为“所有状态为空”
- 模块路径从 `JSON.parse(ksu.moduleInfo()).moduleDir` 取，不硬编码

页面封装了四层：

| 函数 | 行为 |
|---|---|
| `exec(cmd)` | 注册一次性回调、120 秒超时、结束时清理定时器、**写控制台**；全局最多 6 条在飞，其余排队 |
| `run(cmd)` | 只返回 stdout；失败返回 `null` 并写详情面板 |
| `runQuiet(cmd)` | 同上，但失败静默；用于轮询 |
| `shRaw(cmd)` | `(cmd) 2>&1 \| base64`，解码后返回文本；用于所有多字节输出 |

只取 stdout 是刻意的：`run()` 过去把 stderr 拼进返回值，`loadStatus` 会把警告当成
`key=value` 解析。

## 控制台

页面第五个选项卡。它是页面对设备的完整审计记录：

```
12:01:02.345  $ cmd wifi list-scan-results
12:01:03.120  → rc=0 · 775ms
12:01:03.121    BSSID  Frequency ...
                ... 共 43 行 / 3204 字节
```

- `$` 页面发出的命令（显示逻辑命令，不显示 `| base64` 包装）
- `→` / `!` 退出码与耗时；非 0 计入“失败”
- 输出摘要最多 6 行，每行截断 200 字符，并给出总行数/字节数
- 保留最近 800 行；「清空」「复制全部」在面板顶部
- 同时 `console.log('[KsuFastSurfing] ...')`，便于用 WebView 调试
- 自动滚动可关；控制台内容不会触发任何状态变更

控制台是排查第一入口：任何数字不对，先看它上一条命令和返回。

## 启动顺序

```
hasKsu? ──否──▶ 提示从管理器打开
   │是
resolveModDir()
loadHosts()        // base64 -w0 user-hosts，编辑框先就位
refreshAll()       // Promise.all([loadStatus(), loadDiag()])
   │
userActed? ──是──▶ 不覆盖用户操作的反馈
   │否
st('就绪 · <MODDIR>')
```

启动只发原生命令，不调用任何脚本：

| 目的 | 命令 |
|---|---|
| 编辑框 | `base64 -w0 <mod>/user-hosts` |
| 条目数 / 挂载 | `base64 -w0 <mod>/hosts`、`base64 -w0 /system/etc/hosts`、`mount \| grep ' /system/etc/hosts '` |
| 国家码配置 | `base64 -w0 <mod>/config` |
| 当前国家码 | `cmd wifi get-country-code`，失败回退 `dumpsys wifi` |
| 扫描 | `cmd wifi list-scan-results` |
| 链路 | `cmd wifi status` |
| 网关 / 路由表 | `ip route`（无 default 时补 `ip route get 1.1.1.1`） |
| 本机地址 / 掩码 | `ip addr show dev <if>`，前缀长度转点分掩码 |
| 网关延迟 | `ping -c 3 -i 0.2 -W 1 <gw>` |
| 出口 IP / DNS | `curl -sS --compressed -m 6 https://only-983810-58-250-251-51.nstool.laiqukankan.com/` |

启动时不发起任何探测或扫描。

## 出网检查

原来的 `ping github.com` 只能回答“通不通”。现在换成一次 HTTPS GET 打到一个回显页，
一次请求同时回答三件事：

| 字段 | 来源 |
|---|---|
| 出口 IP | 页面回显的客户端地址 |
| 出口 DNS | 页面观察到的递归解析器地址 |
| DNS 判定 | 页面的结论句（`DNS设置正确` / `DNS设置错误`） |

主机名是**泛域名**：`only-<random>.nstool.laiqukankan.com/` 中的随机段每次打开页面
重新生成 32 位小写字母数字，只用于隔离这一次探测，不留任何设备标识（也无需 localStorage）。

该站点 `content-type` 声明 **GBK**，所以响应按 GBK 解码后再匹配中文标签；
用 UTF-8 解会得到乱码，标签永远匹配不上。地址同时按标签和形状匹配，
标签随部署变化时仍能取到。请求带 `-m 6`，握手卡住也不会拖住页面。

## 一次采集

`measure()` 依次执行上述命令，`parseScan` / `parseLink` / `parseNet` 各自解析；
`analyse()` 汇总。缺一段时对应字段为“未获取”，不阻塞其他区块渲染。

命令之间没有固定等待：网关 ping 最多 3 包，DNS 只 1 包。脱敏的 BSSID 原样显示，
页面不会为还原它额外发任何命令。

## 状态条

底部状态条是**所有**操作反馈的唯一出口：

```js
st(text)                 // 普通信息
st(text, {running: true})// 运行中，脉冲点 + 不确定进度条
st(text, {pct: 42})      // 指定进度
st(text, {ok: true})     // 完成
st(text, {ok: false})    // 失败
st(text, {warn: true})   // 警告
```

规则：

- 详情面板 `out()` 只放原始输出，**不得**改状态条
- `busy(btn, fn)` 只负责禁用按钮、改文案、兜底异常；**不在 finally 里刷新数据**
- 每个动作自己决定刷新什么：保存后只读 `status`，改国家码后只读一次 `measure()`
- `userActed` 守卫：用户点过任何按钮后，启动流程不再把状态改成“就绪”

## 四个选项卡

| 选项卡 | 主要元素 | 数据来源 |
|---|---|---|
| 概览 | 链路、周边计数、建议信道、本机地址 / 网关 / 掩码 / 丢包 / 出口 IP / 出口 DNS、路由表、按信号排序的 AP 列表、UNII 分带 | `measure()` |
| hosts | 状态、只读 hosts 视图、折叠编辑框、保存按钮、DNS 解析卡 | 读文件 + `h-save` / `d-run` handler |
| 国家码 | 期望 / 当前、输入框、应用 / 恢复自动 / 诊断 | 读文件 + `diagnoseLayers()` |
| 控制台 | 命令、退出码、耗时、输出摘要 | `exec()` |

### AP 列表的渲染

AP 列表在概览页，按信号从强到弱。每个 SSID 一组：名称居中，下面逐行列出该名称下每个射频的
`BSSID / 信道 / 频率 / RSSI / 类型`。同名多射频（mesh、多频合一）并排显示，
不需要展开。

SSID 是不可信输入：进 DOM 前必须 `esc()`。一个名为 `<img src=x onerror=...>` 的
热点会在 WebView 里执行脚本。

## hosts 页的交互

### 只读视图与编辑

默认显示的是**当前生效**的 `/system/etc/hosts`（读 `sysHs`，即设备上那份文件），
不可编辑。点「编辑」才展开 `user-hosts` 的文本框——一行一个 `IP 域名`，`#` 开头为注释。
保存成功后编辑框自动收起，回到只读视图。

两者分开是有意的：一边是设备上真正在用的内容，一边是你的草稿。旧版把编辑框当成唯一视图，
分不清“我改的”和“实际生效的”。

页面不做域名探测：`curl` 探测依赖外部网络，产出还只是一个“当前线路最快”的地址，
对 CDN 域名并没有稳定意义。需要哪个地址就填哪个，页面只负责合并、写入和挂载。

### DNS 解析

hosts 页下方的独立卡片，用来观察一个域名在某个 DNS 服务器上到底返回多少地址。

| 输入 | 默认 |
|---|---|
| 域名 | `google.com` |
| DNS 服务器 | `8.8.8.8` |
| 次数 | `64`（1–256） |

实现直接沿用 `dns.sh` 的思路，但把 shell + awk 换成了页面 JS：

```
dnsQuery()      域名 → DNS 线格式报文（长度前缀 + QTYPE=A/QCLASS=IN），base64 一次
dnsOne()        printf %s <b64> | base64 -d | timeout N nc -u -w N <server> 53
                  | od -An -tx1 | tr -d " \\n"
dnsParseHex()   十六进制 → 跳过压缩指针/CNAME → 取 A 记录
dnsBurst()      并发 8 路，去重计数
```

结果按**出现次数**排序，并显示 `命中数 / 总次数`——单次查询只会拿到轮转组里的一个地址，
64 次才看得出 CDN 的分布。

**不落盘**。报文以 base64 放在命令行里，`base64 -d` 直接喂给 `nc` 的 stdin；
旧版先在 `/tmp` 写一个 `.bin` 再读，除了占 /data 空间，还要在异常退出时清理。
每个查询同时受 `nc -w` 和 `timeout N` 约束：toybox 的 `nc` 会按 `-w` 退出，
busybox 的个别版本会等 socket 关闭，多一层 `timeout` 才不会占住桥接槽位。

### 保存

```
点「保存并应用」
  ├─ writeFile(user-hosts, 编辑框原文)
  ├─ mergeHosts(编辑框) → hosts 文本
  ├─ writeFile(hosts) + writeFile(system/etc/hosts)
  ├─ chmod 0644 / chown 0:0 / chcon system_file
  ├─ mountTargets(): readlink -f 两个目标，页面去重
  ├─ 每个目标：umount + mount -o bind
  └─ loadStatus() → 状态条报告挂载点数量
```

编辑框内容按字节原样落盘：中文、引号、制表符都不需要转义，因为走 base64，
不拼 shell 字符串。这是唯一会写 `user-hosts` 并挂载的按钮。

## 扫描由系统负责

页面**不触发扫描**，也不提供「重新扫描」按钮。

原因是在真机上测出来的：`cmd wifi start-scan` 返回 0、耗时 30 ms、无任何报错，
但缓存 Age 严格每秒 +1，一条都不刷新。`ScanRequestProxy` 只放行前台应用的扫描请求，
root shell 不在其列。连发三次、关扫描节流、`scan-always-available`、切 uid 2000、
`iw dev scan` 全部无效；唯一真正生效的是打开系统 WLAN 页面（它持有前台请求）。

与其留一个按下去什么都不发生的按钮，不如让它消失：

- 打开 WebUI 时读一次扫描表，之后**不再请求扫描**
- 「链路与网络」里的**扫描新鲜度**照实显示缓存年龄（中位数 + 最快），
  一眼能看出列表是不是几分钟前的
- 需要新数据时，打开一次系统 WLAN 页，再回到本页刷新即可

## 国家码

```
应用
  ├─ 读 config → setKV(CC)
  ├─ 写 config / system.prop（4 个键）
  ├─ resetprop -n（4 个键）
  ├─ cmd wifi force-country-code enabled XX，退避 0/300/600/1200ms
  ├─ iw reg set XX（有 iw 才做）
  └─ countryCodeNow() 读回

恢复自动
  └─ cmd wifi force-country-code disabled
```

## 四层诊断

`diagnoseLayers()` 在原页面里组装报告：framework 的 Country Code 行、
`settings get global wifi_country_code`、supplicant conf、`iw reg get`、
扫描分带、vendor cfg、当前链路，最后生成 verdict。结果只写详情面板与控制台，
不再写 `diagnose.log`。

## 打包

- 仓库：`index.html` 通过 `<script src="diag.js"></script>` 引用数据层，便于测试与阅读
- 构建：`build.sh` 在 `mktemp -d` 副本里把该标签替换为内联 `<script>`，再从副本打包
- 产物：`dist/KsuFastSurfing-vX.Y.zip` 中只有内联后的 `index.html`，没有 `diag.js`
- 约束：构建前后仓库中的 `index.html` 必须逐字节不变；CI 用 `git diff --exit-code` 校验
- 原因：WebView 从内部路径加载时，相对路径 `<script src>` 不可靠

## 测试

`tests/test-status.js` 用 Node 模拟 `ksu.exec` 与 DOM，覆盖：

- 启动顺序与状态条位置
- 控制台记录了命令、退出码与耗时
- 页面没有发出任何 `.sh` 命令
- 保存时一次写入 user-hosts + 两份 hosts + 挂载
- 国家码写入 config / system.prop 并调用 resetprop + `cmd wifi`
- 页面不发出任何扫描命令
- 中文 SSID 穿过桥接不变乱码
- 失败可见，不静默

`tests/test-diag.js` 覆盖解析器与脱敏 BSSID；`tests/test-hosts.js` 覆盖 hosts 合并规则。
三套测试都不需要设备。
