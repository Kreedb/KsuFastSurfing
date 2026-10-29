# 接续开发

> 这份文档是给“下一轮对话 / 下一个维护者”的状态快照。先读这里，再按需跳转。

## 一分钟交接

KsuFastSurfing 是一个 KernelSU / Magisk 模块，做三件事：WiFi 诊断、本机实测的 hosts 加速、
可配置 WiFi 国家码。当前版本 v2.1，功能代码基线 `9755543`。

最近一轮改造把三件事的边界收紧了：开机不联网、不探测；`probe.sh` 只读，结果只追加到
WebUI 编辑框；`user-hosts` 是唯一来源，只有「保存并应用」会写文件并挂载；页面用一次
`collect.sh` 取回全部诊断数据。代码已推 main，**尚未真机验证**，也**没有发新 Release**。

## 当前快照

| 项 | 值 |
|---|---|
| 产品 | KsuFastSurfing v2.1（`versionCode=7`） |
| 分支 | `main` |
| 功能代码基线 | `9755543`（2026-10-29，单次采集 / 单一 hosts 来源 / 只读检测） |
| 文档整理 | 紧随其后的 docs 提交；以 `git log --oneline -3` 为准 |
| 本地产物 | `dist/KsuFastSurfing-v2.1.zip` |
| 产物 SHA256 | `2766f7d1f5a22ac33f4b7e2d631664ff2a50381a564b5342ab94ebd2f1a12123` |
| 远程 Release | 仅 `v1.1` / `v1.2` / `v1.3`，**不要新增** |
| 真机验证 | 新 UI / `collect.sh` / `probe.sh` **尚未**在设备上验证 |

## 硬约束（来自用户，长期有效）

1. **不要擅自发版**：代码可以推 `main`，禁止自动打 tag、禁止自动发 Release。
   本地构建完先交给用户上机测试，测试通过后再谈版本号。
2. **诊断不依赖 `iw`**：零售 ROM 没有它；全部走 `cmd wifi` / `dumpsys` / `/proc`。
3. **区分「扫到 ch100」与「设置里能看到 ch100」**：这是两件事，文档和 UI 都不能混写。
4. **禁止无意义的等待**：不用固定 `sleep N` 做同步；一律「退避 + 上限 + 可提前退出」。
5. **不做自动化 / 不透明操作**：不开机探测、不后台探测、不自动改写 hosts；
   只有用户点击才检测。
6. **检测只读**：结果追加到编辑框，由「保存并应用」一个按钮统一写入并挂载。
7. 失败要可见：状态条说清失败原因，不静默、不用 0 或猜测填充。

## 当前行为契约

### 开机

```
post-fs-data.sh
  ├─ manager.sh build         user-hosts → hosts
  ├─ resetprop 写 4 个国家码属性
  ├─ overlay vendor WCNSS_qcom_cfg.ini（高通机型，文件存在才做）
  └─ manager.sh remount       bind mount 到 /system/etc/hosts、/etc/hosts
```

不联网、不探测、没有 `service.sh`。`post-fs-data` 有 10 秒预算，任何新增步骤都要先问
“会不会拖慢启动”。

### hosts

```
domains → probe.sh（用户点击，只读）→ stdout + probe.log
       → 页面追加到编辑框 → 用户确认 → user-hosts
       → manager.sh apply → hosts → bind mount
```

- `user-hosts` 是唯一输入
- 合并按域名去重，首条胜出
- 检测不写文件；保存不探测

### 诊断

```
collect.sh 一次 exec
  ##scan / ##link / ##route / ##ping / ##dns / ##mac
       ↓
diag.js 分段解析 → analyse() → render()
```

不依赖 `iw`；BSSID 脱敏只在出现 `**` 时读 `wpa_cli`。

## 最近一次改动（v2.1 基线）

- 新增 `collect.sh`：把 8-11 次桥往返压成 1 次，分段输出
- 重写 `probe.sh`：只读、stdout 冠军行、`probe.log` 过程日志、解析短路链、TLS 判定
- `manager.sh`：删 probed 层、`seen[]` 真正去重、删 `probe/refresh/cc-check` 子命令、
  国家码重试改退避
- 删除 `service.sh`：开机不再自动探测
- `action.sh` / `post-fs-data.sh` / `customize.sh` / `config` 同步调整
- WebUI：hosts 页重做（日志面板 + 编辑框 + 单按钮）、启动只读三次命令、
  `busy()` 不再在 finally 全量刷新、扫描改轮询、120 秒超时
- `build.sh`：暂存副本内联，仓库源文件不被改写
- CI：单次构建、自包含校验、去重用例、构建不改源文件
- 测试：新增分段解析、追加不写文件、单按钮 apply、重扫新鲜度等用例
- README 收窄为项目介绍（功能 / 安装 / 快速开始 / 文档入口），实现细节移入 `docs/`：
  `ARCHITECTURE` / `WEBUI` / `DIAGNOSTICS` / `HOSTS` / `DEVELOPMENT` / `TROUBLESHOOTING` / `HANDOFF`

## 验证状态

| 项 | 结果 |
|---|---|
| `node tests/test-diag.js` | 通过 |
| `node tests/test-status.js` | 通过 |
| `busybox ash -n module/*.sh build.sh` | 通过 |
| `./build.sh` 前后 `index.html` SHA256 | 不变 |
| zip 内 `index.html` 自包含 | 是，无 `<script src=` |
| zip 内是否含 `webroot/diag.js` | 否 |
| 合并去重（9.9.9.9 / 8.8.8.8 同名） | 只留 9.9.9.9 |
| `manager.sh status`（本地模拟） | `user=3 / entries=2`，去重可见 |
| Playwright 冒烟（临时脚本，未入库） | 启动 3 次读取、检测追加、已有值不覆盖、保存只 apply 一次 |
| **真机 WebUI / 探测耗时 / wpa_cli 路径** | **未验证** |

## 已知限制

- 开机不检测，hosts 永远是上次保存的内容；要更新需手动打开 WebUI
- `cmd wifi force-country-code` 的返回文案各厂商不同，重试靠关键词匹配
- 部分厂商在 vendor / 固件层固定国家码，属性与 `cmd wifi` 都无效，`diagnose` 只能指出层
- 极老设备 `/data` 就绪慢时，`post-fs-data` 的等待窗口可能不够（当前只检查一次可执行位）
- `module/hosts` 与 `module/system/etc/hosts` 是两份同内容文件；双挂载路径未在真机验证前不动
- AP 列表一次性渲染全部条目，AP 很多时首次切到信道页会慢（P3 未做）
- `probe.sh` 依赖 `curl`；没有 curl 的 ROM 只能看日志里的 `curl missing`

## 待办

### 优先级 P1：真机验证 v2.1

1. 安装 `dist/KsuFastSurfing-v2.1.zip`，重启
2. 打开 WebUI：确认启动无探测、状态条显示“就绪”、hosts 编辑框内容与 `user-hosts` 一致
3. 点「检测 IP」：日志面板应持续滚动；结束后编辑框只追加、不改旧值
4. 点「保存并应用」：`manager.sh status` 的 `entries` 与“已挂载”应同步变化
5. 概览「重新扫描」：确认状态条能区分“新结果”与“旧缓存”
6. 信道页：中文 SSID、同名多射频、UNII 分带是否正常

### 优先级 P2：验证后再决定

- 若真机发现 `collect.sh` 的 `##mac` 段耗时或兼容问题，优先修 `collect.sh`，不要在页面加等待
- 若 AP 很多时信道页卡顿，做分页 / 按需渲染（P3）
- 若 `mount.log` 显示 `/etc/hosts` 与 `/system/etc/hosts` 指向不同 inode，再评估双挂载策略（R10/R11）

### 明确不做

- 频谱仪 / deauth：硬件前提不成立，`capacity.sh` 已能证明；不要在软件层硬凑
- 云端预置 hosts：用户明确要求去掉，改本机探测
- 开机自动探测 / 后台刷新：违反“仅点击检测”

## 关键决策与原因

| 决策 | 原因 |
|---|---|
| 一次 `collect.sh` 采集 | 8-11 次桥往返，每次一个 su fork；最后一个返回前页面无数据 |
| 删除 probed 层 | 检测结果只应进入用户编辑框；第二层会让“看到的”和“生效的”不一致 |
| 检测写 `probe.log` | 探测几十秒，只有 spinner 无法区分“在解析 / 在连接 / 已失败” |
| 删除 `service.sh` | 开机联网拖慢启动；用户要求仅点击检测 |
| MAC 恢复下沉到 shell | 只有出现 `**` 才读 supplicant，退避 ≤1.4s，替代两个固定 `sleep 2` |
| 构建在暂存副本内联 | 旧版原地内联，仓库多出一份 445 行副本，且构建会改源文件 |
| 去重首条胜出 | 同一域名多行会让“编辑框条数”和“生效条数”对不上；首条符合用户直觉 |
| 页面不设背景色 | 交给 KernelSU 调度主题，避免深色模式下白底 |

## 接续时怎么跑

```sh
cd <repo>

# 看状态
git log --oneline -5
git status --short

# 改完先跑
./build.sh
for f in module/*.sh; do busybox ash -n "$f"; done
node tests/test-diag.js
node tests/test-status.js
```

产物在 `dist/`。真机测试通过前不要动 `module.prop` 的版本号，不要打 tag。

## 常见坑

| 坑 | 说明 |
|---|---|
| `ksu.exec` 回调 | 第三个参数是**回调名字符串**，页面要 `window[cb] = ...`；直接传函数会报 `cb is not a function` |
| `import { exec } from 'kernelsu'` | 静态页面里必然失败，且后续代码不执行，页面全空 |
| Android awk | 没有 `strftime`、没有数学函数、`gsub` 反斜杠行为不同 |
| base64 传输 | 中文 SSID / 编辑框内容必须走 base64 + `TextDecoder`，否则乱码 |
| 构建校验 | CI 会 `git diff --exit-code`，任何“构建时改源文件”的做法都会挂 |
| Release | CI 只在 `v*` tag 时发 Release；日常 push 不会发，但也不要手动打 tag |
| 删除文件 | 本仓库的构建/测试不要依赖删除源文件；临时目录用 `mktemp -d` |

## 术语

- **扫到**：`cmd wifi list-scan-results` 里出现该信道 / BSSID
- **设置里能看到**：系统 WiFi 设置界面的网络列表里出现该信道；受 UI 过滤与缓存影响
- **候选**：`probe.sh` 解析出的 IP，尚未测速
- **冠军**：某域名下 TLS 优先、连接最快的 IP，写入 stdout
- **生效**：已写入 `hosts` 并完成 bind mount，`status` 的 `mounted=1`
