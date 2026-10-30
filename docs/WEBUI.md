# WebUI

页面是纯静态 HTML，无框架、无构建期依赖。`index.html` 负责结构、样式、交互与控制台；
`diag.js` 负责解析、合并与采集。打包时把 `diag.js` 内联进
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
| 当前国家码 | `cmd wifi get-country-code`，失败回退 `dumpsys wifi` |
| 扫描 | `cmd wifi list-scan-results` |
| 链路 | `cmd wifi status` |
| 网关 / 路由表 | `ip route`（无 default 时补 `ip route get 1.1.1.1`） |
| 本机地址 / 掩码 | `ip addr show dev <if>`，前缀长度转点分掩码 |
| 外网延迟 / 出口 IP / DNS | `curl -sS --compressed -m 8 -w '<trailer>' https://only-<32位随机>.nstool.laiqukankan.com/` |

启动时不发起任何探测或扫描。

## 出网检查

一次 HTTPS GET 打到一个回显页，同时回答四件事：

| 字段 | 来源 |
|---|---|
| 外网延迟 | `curl -w '%{time_total}'`，完整往返（DNS + TCP + TLS + 首字节） |
| 解析耗时 | 同一个 `-w` 里的 `%{time_namelookup}`，单独展示 |
| 出口 IP / DNS | 页面回显的客户端地址与递归解析器地址，各自带上归属地 |
| DNS 判定 | 页面的结论句（`DNS设置正确` / `DNS设置可能存在问题，请联系您的ISP服务商`） |

归属地就是地址后面那段文字（`广东省深圳市电信`），按行切分后跟各自的地址走，
不会把 IP 城市的名字串到 DNS 那一行。没有标签的老页面回退到“正文里前两个地址”，
此时归属地留空而不是随便配一个。

这一条请求取代了原来的“丢包 + 网关 RTT”：那两项只测第一跳，网关永远 1–3 ms 不丢包，
ISP 出口坏了也看不出来。

主机名是**泛域名**：`only-<random>.nstool.laiqukankan.com/` 中的随机段每次打开页面
重新生成 32 位小写字母数字，只用于隔离这一次探测，不留任何设备标识（也无需 localStorage）。

该站点 `content-type` 声明 **GBK**，所以响应按 GBK 解码后再匹配中文标签；
用 UTF-8 解会得到乱码，标签永远匹配不上。地址同时按标签和形状匹配，
标签随部署变化时仍能取到。请求带 `-m 8`，握手卡住也不会拖住页面。
计时 trailer 用 `\n@@T ` 前缀贴在正文后面，解析前先切掉，
否则那几个数字会被当成“页面上出现的某个地址”。

## 一次采集

`measure()` 依次执行上述命令，`parseScan` / `parseLink` / `parseNet` 各自解析；
`analyse()` 汇总。缺一段时对应字段为“未获取”，不阻塞其他区块渲染。

扫描表与地址查询串行、出网请求与地址查询并行，命令之间没有固定等待。
脱敏的 BSSID 原样显示，页面不会为还原它额外发任何命令。

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

## 三个选项卡

| 选项卡 | 主要元素 | 数据来源 |
|---|---|---|
| 概览 | 链路、周边计数、全信道干扰表、本机地址 / 网关 / 掩码 / 外网延迟 / 出口 IP 与 DNS、路由表、按信号排序的 AP 列表、UNII 分带 | `measure()` |
| 网络配置 | hosts 状态、只读视图 + 折叠编辑框、保存按钮、国家码 | 读文件 + `h-save` / `c-set` handler |
| 控制台 | 命令、退出码、耗时、输出摘要 | `exec()` |

### AP 列表的渲染

信道表在概览页，按信道号顺序列出全部候选信道（38 个），卡片内限高 320px 滚动，
表头 sticky；推荐信道在信道号后加 ★，整行浅色高亮。

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
  ├─ cmd wifi force-country-code enabled XX，退避 0/300/600/1200ms
  └─ countryCodeNow() 读回校验

恢复自动
  └─ cmd wifi force-country-code disabled
```

只有这一条写路径。不写属性、不写配置文件、不碰 `iw`。命令退出 0 不算成功：
框架在芯片不支持某个码时会静默保留旧值，所以必须 `get-country-code` 读回来比。
重启后框架回到系统判断，需要在页面上再点一次。

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
- 国家码只调用 `cmd wifi force-country-code`，不写文件也不注属性
- 读回值不一致时报告失败，而不是沿用退出码
- 页面不发出任何扫描命令
- 中文 SSID 穿过桥接不变乱码
- 失败可见，不静默

`tests/test-diag.js` 覆盖解析器与脱敏 BSSID；`tests/test-hosts.js` 覆盖 hosts 合并规则。
三套测试都不需要设备。
