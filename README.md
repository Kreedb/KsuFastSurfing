# KsuFastSurfing

KernelSU / Magisk 模块：把 **hosts 加速**（FCM + GitHub）和 **WiFi 国家码** 放在同一个无系统改写的模块里。

纯脚本实现，不碰真实分区，卸载即恢复。

<p align="center">
  <code>Android 8+</code> · <code>KernelSU</code> · <code>Magisk</code> · <code>systemless</code>
</p>

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
status    机器可读状态（供 WebUI 消费）
```

`post-fs-data` / `service` / `action` / WebUI 全部只是调它，没有第二份逻辑。
这意味着：任何时刻你都可以手动跑一次 `manager.sh refresh` 把状态修正，
不需要重启，也不需要理解某个具体脚本的内部状态。

### 7. 失败要留证据

三个日志，各自对应一个阶段：

```
/data/adb/modules/gcm-hosts-us/mount.log     挂载结果 + 校验结论
/data/adb/modules/gcm-hosts-us/service.log   开机后 refresh 的返回
/data/adb/modules/gcm-hosts-us/manager.log   下载、合并、国家码的每次尝试
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
├── dist/                构建产物（不入库）
└── module/              模块本体，原样打进 zip 根目录
    ├── module.prop
    ├── config           运行配置（CC / USE_MTALK / USE_GITHUB）
    ├── manager.sh       唯一控制面
    ├── post-fs-data.sh  启动阶段：不联网
    ├── service.sh       开机后：异步刷新
    ├── action.sh        管理器「运行」按钮
    ├── uninstall.sh     清理
    ├── customize.sh     安装期权限设置
    ├── system.prop      国家码属性
    ├── hosts            合并产物（由 manager.sh build 生成）
    ├── user-hosts       用户手动条目（最高优先级）
    ├── sources/         云端快照（离线兜底）
    ├── system/etc/hosts metamodule 路径备份
    └── webroot/         WebUI
```

### 新增一条云端源

1. 在 `manager.sh` 顶部加 `URL_<NAME>` 和 `SRC_<NAME>` 常量
2. `config` 加 `USE_<NAME>=1`，`conf_get` 默认值同步
3. `cmd_build` 里按优先级顺序插入 `emit_section "$SRC_<NAME>" "<显示名>"`
4. `cmd_status` 加对应的计数（`status` 输出加一行 `字段=值`）
5. `cmd_refresh` 的下载分支加一行
6. WebUI 加快关 + 状态行
7. 打包一份初始快照进 `sources/`

优先级顺序固定为「用户 > 后加的重要源 > 先加的源」，改动时同步更新本文件第 2 节。

### 脚本规范

- **Shebang 一律 `#!/system/bin/sh`**，用 `busybox ash -n` 校验（不是 bash — Android 上没有 bash）
- **`MODDIR` 用 `case "$0" in */*) MODDIR=${0%/*} ;; *) MODDIR=. ;; esac`**
  而不是 `${0%/*}` —— 后者在 `sh manager.sh` 这种相对调用下会得到 `manager.sh`
- **不依赖 `curl`/`wget` 必然存在**，按 `curl → wget → busybox wget` 顺序降级
- **修改状态前先 `umount`**，挂载操作要幂等
- **所有写文件走「临时文件 + 校验 + mv」**，不做原地覆盖

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
./module/manager.sh build                    # 合并可用
grep -c '^# ---' module/hosts                # 分层存在
awk '/^[0-9]/{print $2}' module/hosts | sort | uniq -d   # 无重复（应无输出）
```

---

## 功能

| 能力 | 说明 |
|---|---|
| hosts 云端合并 | FCM（mtalk）与 GitHub 两个源，可独立开关 |
| 手动条目 | WebUI 编辑，IPv4/IPv6，`#` 注释，优先级最高 |
| 免写分区 | bind mount，`/system/etc/hosts` 原文件不动 |
| WiFi 国家码 | 默认 US，可改任意两位码，双通道生效 |
| WebUI | 状态卡片、源开关、国家码、手动条目编辑 |
| 离线可用 | 随包带快照，无网络也能正常开机 |

### 云端源

| 层 | 项目 | 地址 |
|---|---|---|
| mtalk / FCM | [yangFenTuoZi/fcm-hosts](https://github.com/yangFenTuoZi/fcm-hosts) | `refs/heads/master/hosts` |
| GitHub | [maxiaof/github-hosts](https://github.com/maxiaof/github-hosts) | `refs/heads/master/hosts` |

均经 `https://gh-proxy.org/` 前缀访问。数据版权归各自项目所有，本项目只做聚合。

---

## 安装

1. 从 [Releases](../../releases) 下载 `gcm-hosts-us-vX.Y.zip`
2. KernelSU 管理器 → 模块 → 从本地安装 → 选择 zip
3. 重启

Magisk 同样适用（`cmd wifi` 需要 Android 10+）。

> 若你已装 meta-overlayfs 之类的 metamodule，`module/system/etc/hosts` 那条路也会生效，
> 但 bind mount 依然是主路径，两者内容相同。

## 使用

模块详情页 → 打开 WebUI。

- **云端来源**：勾选后点「从云端刷新」，即时下载并重新挂载
- **WiFi 国家码**：输入两位码（如 `US`/`CN`/`JP`）点「应用」；「恢复自动」交给系统判断
- **手动条目**：每行 `IP 域名`，保存后自动应用

没有 WebUI 界面时也能用命令行：

```sh
su -c 'sh /data/adb/modules/gcm-hosts-us/manager.sh status'
su -c 'sh /data/adb/modules/gcm-hosts-us/manager.sh refresh'
su -c 'sh /data/adb/modules/gcm-hosts-us/manager.sh set-cc JP'
```

## 配置

`module/config`：

```
CC=US          # WiFi 国家码，两位字母
USE_MTALK=1    # 1 启用 mtalk / FCM 层
USE_GITHUB=1   # 1 启用 GitHub 层
```

## 排障

先看日志，再看状态：

```sh
cat /data/adb/modules/gcm-hosts-us/mount.log     # 挂载是否成功
cat /data/adb/modules/gcm-hosts-us/manager.log   # 下载/合并/国家码
sh /data/adb/modules/gcm-hosts-us/manager.sh status
```

| 现象 | 常见原因 |
|---|---|
| `mounted=0` | 未重启；或 SELinux 阻止 bind mount（看 `mount.log`） |
| hosts 生效但没加速 | 运营商/DNS 走了 DoT/DoH，绕过 hosts |
| 国家码不生效 | 厂商 ROM 固定了 `ro.boot.wificountrycode`；或 `cmd wifi` 返回格式不同（看 `manager.log`） |
| 云端刷新失败 | 代理不可用；此时保留旧缓存，不影响使用 |

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
