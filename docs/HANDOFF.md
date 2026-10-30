# 接续开发

> 这份文档是给“下一轮对话 / 下一个维护者”的状态快照。先读这里，再按需跳转。

## 一分钟交接

KsuFastSurfing 是一个 KernelSU / Magisk 模块，做三件事：WiFi 诊断、本机实测的 hosts 加速、
可配置 WiFi 国家码。当前版本 v2.2，功能代码已完成“去后台脚本”改造：页面直接执行
Android 原生命令，模块里只剩三个生命周期钩子。

**v2.2 已发版（tag `v2.2`），真机验证仍在进行中。**

## 当前快照

| 项 | 值 |
|---|---|
| 产品 | KsuFastSurfing v2.2（`versionCode=8`） |
| 分支 | `main`（已提交并推送） |
| 功能代码 | UI 直连命令；`manager.sh` / `collect.sh` / `probe.sh` / `diagnose.sh` / `capacity.sh` / `action.sh` 已删除 |
| 本地产物 | `dist/KsuFastSurfing-v2.2.zip` |
| 产物 SHA256 | 以 `./build.sh` 最后一次输出为准（每次重构建都会变） |
| 远程 Release | `v1.1` / `v1.2` / `v1.3` / `v2.2` |
| 真机验证 | **未验证** |

## 硬约束（来自用户，长期有效）

1. **发版须经用户明确要求**：v2.2 是用户指示“审查代码后，提交发版”后才打的 tag。
   默认流程仍是代码推 `main`、本地构建交给用户上机测试，测试通过后再谈版本号。
2. **诊断不依赖 `iw`**：零售 ROM 没有它；全部走 `cmd wifi` / `dumpsys` / `/proc`。
3. **区分「扫到 ch100」与「设置里能看到 ch100」**：这是两件事，文档和 UI 都不能混写。
4. **禁止无意义的等待**：不用固定 `sleep N` 做同步；一律「退避 + 上限 + 可提前退出」。
5. **不做自动化 / 不透明操作**：不开机探测、不自动改写 hosts、不主动请求扫描；
   只有用户点击才检测。
6. **检测只读**：结果追加到编辑框，由「保存并应用」一个按钮统一写入并挂载。
7. 失败要可见：状态条说清失败原因，不静默、不用 0 或猜测填充。
8. **页面不执行模块脚本**：所有功能命令由页面直接发出，并出现在控制台。

## 当前行为契约

### 开机

```
post-fs-data.sh
  ├─ resetprop 写 4 个国家码属性
  ├─ overlay vendor WCNSS_qcom_cfg.ini（高通机型，文件存在才做）
  └─ bind mount module/hosts → /system/etc/hosts、/etc/hosts
```

不联网、不采集、不调用其他脚本。`post-fs-data` 有 10 秒预算，任何新增步骤都要先问
“会不会拖慢启动”。

### hosts

```

       ──▶ 编辑框（只追加）──▶ 用户确认
       ──▶ writeFile(user-hosts) + mergeHosts() + writeFile(hosts ×2)
       ──▶ umount + mount -o bind
```

- `user-hosts` 是唯一输入
- 合并按域名去重，首条胜出（`mergeHosts()`，纯 JS）
- 页面不探测、不扫网；保存只写用户给的条目

### 诊断

```
measure()
  cmd wifi list-scan-results / cmd wifi status / ip route
  ping 网关 / curl 回显页（出口 IP + DNS）
       ↓
parseScan / parseLink / parseNet → analyse() → render()
```

不依赖 `iw`，也不读 `wpa_cli`（AIDL supplicant 上会挂满 10 秒）。
BSSID 被框架脱敏时原样显示，不做还原。

### 国家码

```
c-set
  setKV(config, CC) + system.prop（4 键）
  resetprop -n（4 键）
  cmd wifi force-country-code enabled XX（退避 0/300/600/1200ms）
  iw reg set XX（有 iw 才做）
  countryCodeNow() 读回
```

## v2.2 改动

**去后台脚本**
- 删除 `manager.sh`、`collect.sh`、`probe.sh`、`diagnose.sh`、`capacity.sh`、`action.sh`
- `post-fs-data.sh` 收窄为“属性 + vendor overlay + 挂载页面上次保存的 hosts”
- `build.sh` 的 `EXEC` 只剩三个钩子；CI 加“被删脚本不能回来”守卫

**页面**
- 新增「控制台」选项卡：每条 `exec` 记录逻辑命令、rc、耗时、解码输出摘要
- 五个选项卡并为四个：信道页并入概览，顶掉原来的「信号最强的周边 AP」卡
- 顶部导航不再 sticky
- 概览「链路与网络」新增本机地址 / 子网掩码 / 出口 IP / 出口 DNS / DNS 判定，
  下方新增路由表卡片；出网检查由 `ping github.com` 换成 HTTPS GET 回显页
- hosts 页：默认显示设备上实际生效的只读 hosts，点「编辑」才展开 `user-hosts`
- 国家码并入网络配置页，5GHz 可用性与详细输出面板删除

**移除**
- 扫描触发（`cmd wifi start-scan` 在目标机型上被 `ScanRequestProxy` 静默丢弃，
  连发三次、关节流、切 uid、`iw dev scan` 全部无效，只有系统 WLAN 页有效）
- 硬件能力检测（`detectCapacity()` 与整个卡片）
- hosts 域名探测（`probeAll()` / `curl` 测速 / `domains` 读取）
- BSSID 还原（`wpa_cli` 在 AIDL supplicant 上挂满 10 秒仍不回包，`iw` 零售 ROM 无）

**修正的真实 bug**
- `uniiOf()` 把 ch36–48 误并入 UNII-2A，应为 UNII-1
- `ip route` 在 per-network 表下没有 `default` 行 → 网关/掩码全空、网关 ping 被跳过；
  现用 `ip route get 1.1.1.1` 补一条合成 default

## 验证状态

| 项 | 结果 |
|---|---|
| `node tests/run.js` | 通过（三套并行，约 0.4 秒；含“零 `.sh` 命令”断言） |
| Playwright 渲染 | 概览 / hosts / 导航非 sticky / 无 JS 报错，均通过 |
| 桥接并发 | 页面限制 6 条在飞；真机桥接是否支持并发待验证 |
| `dash -n module/*.sh build.sh`（由 `./build.sh` 执行） | 通过 |
| `./build.sh` | 通过（内置测试 + 产物校验），11 个文件 |
| zip 内 `index.html` 自包含 | 是，无 `<script src=` |
| zip 内是否含 `webroot/diag.js` | 否 |
| zip 内是否含已删除脚本 | 否 |
| **真机 WebUI / 挂载** | **未验证** |

## 已知限制

- 开机不检测，hosts 永远是上次保存的内容；要更新需手动打开 WebUI
- `cmd wifi force-country-code` 的返回文案各厂商不同，重试靠关键词匹配
- 部分厂商在 vendor / 固件层固定国家码，属性与 `cmd wifi` 都无效，诊断只能指出层
- 控制台只保留 800 行；长输出只显示前 6 行摘要
- 页面写文件用单条命令（`printf … | base64 -d > file`），hosts 极大时可能触及命令行长度
- AP 列表一次性渲染全部条目，AP 很多时首次打开概览会慢（P3 未做）
- 出网检查依赖 `curl`，精简 ROM 可能没有，失败会明确报出
- 回显页是第三方服务，域名 `nstool.laiqukankan.com` 失效时该行显示“出网失败”，
  其余卡片不受影响

## 待办

### 优先级 P1：真机验证

1. 安装 `dist/KsuFastSurfing-v2.2.zip`，重启
2. 打开 WebUI：控制台应显示启动命令，状态条显示“就绪”
3. 编辑框里改几行 →「保存并应用」：控制台应出现 `writeFile` 与两次 `mount -o bind`
4. 点「保存并应用」：`h-entries` 与“已挂载”同步变化；重启后仍在
5. 概览：本机地址 / 掩码 / 出口 IP / 出口 DNS / 路由表都有值
6. 概览：AP 列表按信号排序，页面不发出任何扫描请求
7. hosts：默认只读显示生效内容，点「编辑」能改、保存后自动收起
8. 概览信道表：38 个信道全列，推荐信道在信道号后带 ★ 且整行高亮
9. 国家码：应用后 `cmd wifi get-country-code` 与页面一致；重启后仍是配置值

### 优先级 P2：验证后再决定

- 若 AP 很多时概览页卡顿，做分页 / 按需渲染（P3）
- 若 `mount.log` 显示 `/etc/hosts` 与 `/system/etc/hosts` 指向不同 inode，再评估双挂载策略

### 明确不做

- 频谱仪 / deauth：硬件前提不成立（无 survey / 无监听），不要在软件层硬凑
- 云端预置 hosts：用户明确要求去掉
- 开机自动探测 / 后台刷新：违反“页面不主动采集”
- 恢复任何采集/控制脚本：需要新能力时，由页面直接发命令

## 关键决策与原因

| 决策 | 原因 |
|---|---|
| 删除全部采集/控制脚本 | 用户要求“全部由 UI 驱动”；一份逻辑只应存在于一个地方 |
| 页面直接发原生命令 | 脚本的 stdout 协议（`##section` / `key=value`）没有第二个消费者，维护成本只剩同步风险 |
| 保留三个生命周期钩子 | 开机与卸载时 WebView 不存在，无法由 UI 替代 |
| 控制台显示逻辑命令、解码输出 | 桥接的 `\| base64` 是实现细节；用户要看的是 `cmd wifi …` 和可读文本 |
| 采集全部放在页面 | 不再需要 `collect.sh` / `probe.sh`，每条命令都在控制台里可见 |
| 合并规则放在 JS | 与编辑框同源，测试可直接跑；awk 的 `seen[]` 曾写过却从未读 |
| 保存写两份 hosts | KernelSU 的 metamodule 路径与 bind mount 路径各一份，哪条通都能工作 |
| 检测结果只进编辑框 | 第二层会让“看到的”和“生效的”不一致 |
| 页面不设背景色 | 交给 KernelSU 调度主题，避免深色模式下白底 |

## 接续时怎么跑

```sh
cd <repo>

# 看状态
git log --oneline -5
git status --short

# 改完先跑（语法、守卫、三套测试、打包、产物校验，全在这一条里）
./build.sh
```

产物在 `dist/`。真机测试通过前不要动 `module.prop` 的版本号，不要打 tag。

## 常见坑

| 坑 | 说明 |
|---|---|
| `ksu.exec` 回调 | 第三个参数是**回调名字符串**，页面要 `window[cb] = ...`；直接传函数会报 `cb is not a function` |
| `import { exec } from 'kernelsu'` | 静态页面里必然失败，且后续代码不执行，页面全空 |
| 中文输出 | 必须走 `shRaw()` 的 base64 包装；直接取 stdout 会按 Latin-1 解码成乱码 |
| 控制台显示 base64 | `exec` 用 `shownCmd` / `shownOut` 还原逻辑命令与文本；新增命令仍走 `shRaw` 即可 |
| Android awk | 页面已不用 awk 分析；排障命令也尽量只用 sed/grep/cut |
| base64 传输 | 编辑框与 SSID 必须走 base64 + `TextDecoder`，否则乱码 |
| 构建校验 | CI 会 `git diff --exit-code`，任何“构建时改源文件”的做法都会挂 |
| Release | CI 只在 `v*` tag 时发 Release；日常 push 不会发，但也不要手动打 tag |
| 测试的定时器 | 只把 <5 s 的定时器压到 0；120 s 的 exec 超时必须保持，否则命令会被提前拒绝 |
| 删除文件 | 本仓库的构建/测试不要依赖删除源文件；临时目录用 `mktemp -d` |

## 术语

- **扫到**：`cmd wifi list-scan-results` 里出现该信道 / BSSID
- **设置里能看到**：系统 WiFi 设置界面的网络列表里出现该信道；受 UI 过滤与缓存影响
- **候选**：用户填进编辑框的条目，保存前尚未生效
- **冠军**：某域名下 TLS 优先、连接最快的 IP，追加到编辑框
- **生效**：已写入 `hosts` 并完成 bind mount，页面显示“已挂载”
