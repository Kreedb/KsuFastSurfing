# hosts 与 IP 探测

## 数据流

```
module/domains                 用户维护的域名列表
      │
      ▼
probe.sh                       只读：解析 → 测速 → 排序
      │  stdout: IP<TAB>host
      │  probe.log: 过程
      ▼
WebUI 编辑框                   只追加，不覆盖用户已有条目
      │  用户点「保存并应用」
      ▼
module/user-hosts              唯一输入
      │  manager.sh build：校验 + 去重
      ▼
module/hosts  ──bind mount──▶  /system/etc/hosts
```

没有云端预置源。公共 hosts 里的 IP 对别人快、对你未必，所以候选地址来自本机解析，
可达性也由本机实测。

## 只读保证

`probe.sh`：

- 不写 `user-hosts`
- 不调用 `manager.sh`
- 不改 hosts、不挂载
- 只在被 WebUI 调用时运行，没有开机 / 定时触发

它唯一写的文件是 `probe.log` 和临时目录 `.probe/`。

## 解析：短路链

对每个域名依次尝试，**拿到地址就停**：

| 顺序 | 方式 | 上限 | 说明 |
|---|---|---|---|
| 1 | `ping -c 1 -W 1 <host>` 的输出 | 1 s | 零售 ROM 一定有 toybox ping，它自己会解析 |
| 2 | `getent hosts` | 命令存在才跑 | 部分 ROM 带 |
| 3 | `nslookup` | 命令存在才跑 | 部分 ROM 带 |
| 4 | Cloudflare DoH | `--max-time 2` | JSON，取 type=1 的 A 记录 |
| 5 | Google DoH | `--max-time 2` | 前一个没有结果才问 |

旧版本无条件跑完 ping、getent、nslookup 和两个 DoH，每个域名固定 5-7 秒，
即使第一次解析已经有答案。现在每一步都可能提前结束。

DoH 响应按 `{` 切开，只保留 `"type":1` 且 `"data"` 是点分 IPv4 的记录；
CNAME 的 `data` 是域名，会被形状过滤掉。

候选地址最后 `sort -u` 去重。

## 测速：看连接，不看 HTTP 状态

```sh
curl -sS -o /dev/null -k \
  --connect-timeout "$TIMEOUT" --max-time "$TIMEOUT" \
  --resolve "$h:443:$ip" \
  -w '%{time_connect} %{time_appconnect}' \
  "https://$h/"
```

- `--resolve` 把域名钉到候选 IP，TLS SNI 仍是原域名，测的就是 hosts 生效后的真实路径
- `time_connect` 为 0 或空 → 不可达
- `time_appconnect` 非 0 → TLS 握手完成，`tls=1`
- **不使用 curl 退出码**：403、证书错误、TLS 失败的站点同样证明链路是通的；
  hosts 加速真正需要的是“能连上并完成握手”

超时同时作用于连接与总时长，不再 ×2。默认 3 秒，范围 1-10。

## 排序

```
tls 降序 → time_connect 升序 → 每个域名只留第一条
```

先看 TLS 是否完成，再看连接耗时。一个握手失败的 IP 即使 TCP 很快，也不能用于
HTTPS 加速。

## 输出契约

stdout 只有冠军行，每行：

```
142.250.1.1<TAB>fcm.googleapis.com
```

页面只接受 `IPv4<TAB>host` 形状，其他行（日志、噪声）忽略。

退出码：

| 情况 | 退出码 |
|---|---|
| `domains` 为空 | 1 |
| 没有 `curl` | 1（日志写明） |
| 解析不到任何候选 | 1 |
| 正常结束（哪怕 0 个可达） | 0 |

页面不把退出码当作唯一判据，仍以 stdout 里是否有冠军行为准。

## 日志

`probe.log` 是 ASCII，逐行 `[HH:MM:SS] ...`，页面每 800ms 读一次：

```
[10:00:00] start domains=12 timeout=3s threads=8
[10:00:01] resolve github.com -> 2 ip
[10:00:01] resolve mtalk.google.com -> none
[10:00:02] candidates=17
[10:00:03] ok   github.com 140.82.113.4 0.12s tls=1
[10:00:03] fail github.com 20.205.243.166
[10:00:08] done hosts=9 candidates=17 seconds=8
```

- 一个域名解析出多个 IP 时逐条 `ok` / `fail`
- `done` 行是页面停止轮询的信号；即使没有 `done`，exec 结束也会停
- 日志面板只是反馈，最终结果以 stdout 为准

页面轮询上限 90 次（约 72 秒），有界、随命令结束停止，不是常驻定时器。

## 页面侧：只追加

`appendDetected()`：

1. 逐行匹配 `IPv4<TAB>host`
2. 收集编辑框里已有的域名（跳过注释行）
3. 已存在的域名**保留用户的值**，不覆盖、不重复
4. 新域名追加到末尾，返回实际追加条数

状态条会同时报告“已追加 N 条”和“M 条已存在未覆盖”。检测结束后不写任何文件。

## 保存：一个按钮

```
printf %s <base64> | base64 -d > user-hosts && manager.sh apply
```

- 编辑框内容先 `TextEncoder` → base64，再由 shell 解码，字节原样落盘
- 不拼 shell 字符串，所以引号、制表符、中文都不需要转义
- 只有 `rc=0` 才提示成功，随后只刷新 `status`（不重读扫描、不重新探测）

## 合并与去重

`manager.sh build` 用一段 awk 完成：

- 跳过注释与空行
- 第一列必须是 IPv4 或 IPv6，否则整行丢弃
- 同一行多个域名时逐个输出
- **按域名去重，第一条胜出**（`seen[]` 真正被读取）
- 输出固定头：生成时间、来源说明、`127.0.0.1 localhost`、`::1 localhost ...`

因此 `status` 的 `user`（编辑框里的非注释行数）与 `entries`（实际生效条数）可能不同，
差值就是被去重的行数。

## 配置

`module/config`：

```
CC=US
PROBE_TIMEOUT=3   # 单次连接/总时长上限，1-10 秒
PROBE_THREADS=8   # 并发解析/测速数，1-16
```

页面会把输入 clamp 到范围内并写回配置；`probe.sh` 读取时再做一次兜底校验。

`module/domains` 一行一个域名，`#` 注释、空行忽略。加域名不需要改脚本。

并发实现是 shell 后台任务 + 每 N 个 `wait` 一次，不依赖 `xargs -P`（部分 toybox 没有）。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 0 个候选 | 所有解析方式都拿不到地址：DNS 被拦、未联网、域名拼错 | 看日志的 `resolve ... -> none`；调超时无效 |
| 有候选但全不可达 | 443 连不上：被墙、IP 失效、网络需要代理 | 看 `fail` 行；换网络或换域名 |
| 检测很快就结束、无结果 | `curl` 不存在（日志会写） | 装带 curl 的 ROM / busybox |
| 日志不动 | 页面轮询失败或 exec 未启动 | 看状态条；必要时命令行跑一次 `probe.sh` |
| 保存后没生效 | `mounted=0`、SELinux 阻止挂载 | 看 `mount.log`；确认已重启 |
| 加速没感觉 | 应用走 DoT/DoH，绕过 hosts | 关闭系统私人 DNS 再测 |
