# WebUI

页面是纯静态 HTML，无框架、无构建期依赖。`index.html` 负责结构与样式，`diag.js` 负责
解析与分析；打包时把 `diag.js` 内联进 `dist` 副本，仓库里两者保持分离。

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

页面封装了三层：

| 函数 | 行为 |
|---|---|
| `exec(cmd)` | 注册一次性回调、120 秒超时、结束时清理定时器 |
| `run(cmd)` | 只返回 stdout；失败返回 `null` 并写详情面板 |
| `runQuiet(cmd)` | 同上，但失败静默；用于轮询 |

只取 stdout 是刻意的：`run()` 过去把 stderr 拼进返回值，`loadStatus` 会把警告当成
`key=value` 解析。

## 启动顺序

```
hasKsu? ──否──▶ 详情面板提示从管理器打开
   │是
resolveModDir()
loadHosts()        // base64 -w0 user-hosts，编辑框先就位
refreshAll()       // Promise.all([loadStatus(), loadDiag()])
   │
userActed? ──是──▶ 不覆盖用户操作的反馈
   │否
st('就绪 · <MODDIR>')
```

启动只读三次命令：`manager.sh status`、`collect.sh`、`base64 -w0 user-hosts`。
**不会**调用 `probe.sh`，也不会触发扫描。

## 一次采集协议

`collect.sh` 把一次渲染需要的全部数据打印成分段文本：

```
##scan   cmd wifi list-scan-results
##link   cmd wifi status
##route  ip route
##ping   网关 3 包（无网关时为空）
##dns    一次外网解析，输出 rc=N
##mac    wpa_cli scan_results（仅当 BSSID 出现 ** 时才读）
```

页面侧：

- `shText()` 用 `(cmd) 2>&1 | base64` 传输，再用 `TextDecoder` 解码，保证中文 SSID 不变乱码
- `sections()` 按行首 `##name` 切段；SSID 内部出现 `##` 不算分段
- `parseScan` / `parseLink` / `parseNet` / `parseWpa` 各自只接收自己的段
- 缺段时对应字段为“未获取”，不阻塞其他区块渲染

早前每个数据源一次 `exec`，一次刷新 8-11 次桥往返，最后一个返回前页面不显示任何数字。
现在一次采集、一次解析。

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

- 详情面板 `out()` 只放原始输出，**不得**改状态条。曾经探测成功的原始输出覆盖了
  “5 / 12 可用”的摘要，看起来像失败
- `busy(btn, fn)` 只负责禁用按钮、改文案、兜底异常；**不在 finally 里刷新数据**
- 每个动作自己决定刷新什么：保存后只读 `status`，扫描后只读一次 `collect.sh`，
  检测结束后什么都不读
- `userActed` 守卫：用户点过任何按钮后，启动流程不再把状态改成“就绪”

## 四个选项卡

| 选项卡 | 主要元素 | 数据来源 |
|---|---|---|
| 概览 | 链路、周边计数、建议信道、网关 / 丢包 / DNS、最强邻居 | `collect.sh` 全量 |
| 信道 | 按 SSID 分组的 AP 列表、UNII 分带、硬件能力 | `collect.sh` + `capacity.sh` |
| hosts | 状态、检测卡、日志、编辑框、保存按钮 | `manager.sh status`、`probe.sh` |
| 国家码 | 期望 / 当前、输入框、应用 / 恢复自动 | `manager.sh status`、`set-cc` |

### 信道页的渲染

每个 SSID 一组：名称居中，下面逐行列出该名称下每个射频的
`BSSID / 信道 / 频率 / RSSI / 类型`。同名多射频（mesh、多频合一）并排显示，
不需要展开。

SSID 是不可信输入：进 DOM 前必须 `esc()`。一个名为 `<img src=x onerror=...>` 的
热点会在 WebView 里执行脚本。

## hosts 页的交互

### 检测

```
点「检测 IP」
  ├─ clamp 超时 1-10、线程 1-16，写回 config
  ├─ rm -f probe.log
  ├─ 显示日志面板，st('检测中…')
  ├─ 启动 probe.sh（一次 exec）
  ├─ 并行轮询：每 800ms cat probe.log，最多 90 次
  │    └─ 日志出现 done 或 exec 结束即停
  ├─ 结束后再读一次完整日志
  ├─ 从 stdout 提取 IP<TAB>host 行
  ├─ appendDetected()：只追加编辑框里没有的域名
  └─ st('检测结束：N 条已追加…')
```

日志轮询有上限、随命令结束停止，不是无限定时器。检测期间不写任何状态文件
（只有 `probe.log`、`probe.sh` 自己的 `.probe/` 临时目录，以及 `config` 里的两个参数）。

### 追加规则

- 只接受 `IPv4<TAB>host` 形状的行
- 编辑框里已有的域名**保留用户的值**，不覆盖、不重复
- 返回值是实际追加的条数；状态条同时报告“已存在未覆盖”的数量

### 保存

```
点「保存并应用」
  └─ printf %s <base64> | base64 -d > user-hosts && manager.sh apply; echo rc=$?
       ├─ rc=0 → loadStatus() → st('已保存 N 条并重新挂载')
       └─ 其它 → 详情面板显示原始输出，状态条报失败
```

编辑框内容按字节原样落盘：中文、引号、制表符都不需要转义，因为不拼 shell 字符串。
这是唯一会写 `user-hosts` 并挂载的按钮。

## 重新扫描

```
cmd wifi start-scan
  └─ 轮询 collect.sh scan，间隔 400 / 600 / 800 / 1000×6 ms
       └─ 取 age 最小值是否下降（阈值 1 秒）判断是否有新结果
```

新鲜度看**最小值**：最大值由缓存里最旧的一条决定，扫描真的落地时几乎不变，
按钮看起来像坏了。页面同时显示 age 中位数描述整份缓存的新旧、最小值作为新结果到达的证据。

## 打包

- 仓库：`index.html` 通过 `<script src="diag.js"></script>` 引用数据层，便于测试与阅读
- 构建：`build.sh` 在 `mktemp -d` 副本里把该标签替换为内联 `<script>`，再从副本打包
- 产物：`dist/KsuFastSurfing-vX.Y.zip` 中只有内联后的 `index.html`，没有 `diag.js`
- 约束：构建前后仓库中的 `index.html` 必须逐字节不变；CI 用 `git diff --exit-code` 校验
- 原因：WebView 从内部路径加载时，相对路径 `<script src>` 不可靠

## 测试

`tests/test-status.js` 用 Node 模拟 `ksu.exec` 与 DOM，覆盖：

- 启动顺序与状态条位置
- 检测只追加、不写文件
- 已有条目不被覆盖
- 单按钮只执行一次 `printf … | base64 -d … && apply`
- 扫描陈旧 / 新鲜的判断
- 中文 SSID 穿过桥接不变乱码
- 能力检测的 `yes/no/unknown` 三态
- 失败可见，不静默

`tests/test-diag.js` 覆盖解析器：敌意 SSID、RSSI 形式、UNII 分带、分段采集、MAC 恢复、
推荐排序。两套测试都不需要设备。
