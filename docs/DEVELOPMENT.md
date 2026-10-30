# 开发

## 环境

| 工具 | 用途 | 备注 |
|---|---|---|
| `python3` | 打包时内联 `diag.js`、写 zip 权限位 | 构建必需 |
| `node` | 跑回归测试 | 不参与打包 |
| `dash` | `dash -n` 语法检查 | POSIX，与 Android 的 ash 足够接近，任何发行版自带 |
| `zip` | 不需要 | `build.sh` 直接用 Python `zipfile` 写 POSIX 权限位 |

## 构建

```sh
./build.sh
```

流程：

1. 从 `module/module.prop` 读 `id` / `version`
2. `mktemp -d` 建暂存目录，`cp -a module/.` 复制过去
3. 在**暂存副本**里把 `<script src="diag.js"></script>` 替换成内联 `<script>`
4. 校验副本里没有 `<script src=`，且 `diag.js` 不再单独存在
5. 用 Python `zipfile` 打包，显式写 `0755` / `0644` 权限位，时间戳固定为 1980-01-01
6. 输出 `dist/KsuFastSurfing-vX.Y.zip` 与 SHA256

要点：

- **构建不得修改仓库文件**。内联只在暂存副本里做，CI 用 `git diff --exit-code` 校验
- `diag.js` 不进包：产物里的 `index.html` 已经包含它
- 运行日志（`*.log`）不进包
- 同一份源码在任意机器上应得到相同 zip（时间戳与权限位固定）
- `EXEC` 集合只有 `post-fs-data.sh` / `uninstall.sh` / `customize.sh`

## 测试

```sh
node tests/run.js              # 三套并行，约 0.4 秒
node tests/run.js --verbose    # 附带每个用例的输出
node tests/test-diag.js        # 也可以单独跑某一份
```

`tests/run.js` 把三份测试作为独立进程**同时**启动，墙钟时间取最慢的一份而不是累加；
任一份失败返回 1，且只打印失败那份的 `FAIL` 行，避免通过的噪音盖住问题。

### test-diag.js

纯解析器测试，不碰 DOM 与设备：

- 敌意 SSID：`|`、`=`、引号、反斜杠、`<img onerror>`、中文、`null`
- RSSI 形式：`-51`、`-51(0:-51/1:-56)`
- 表头 / 空行 / 非 WiFi 频段
- UNII 分带：ch36 / 52 / 100 / 144 / 149 / 165
- 链路解析：SSID 含逗号
- 推荐排序：5GHz 优先、DFS 靠后、候选只来自标准栅格
- BSSID 脱敏：值是 `**` 时原样保留，不猜不补
- `rssiBand` 四档
- `parseCC` 的厂商文案

### test-hosts.js

`mergeHosts()` / `countHosts()` / `setKV()` 的规则：

- 全注释输入不产生空的 `# --- user entries ---`
- 同一域名两行，第一条胜出且只出现一次
- 一行多个域名逐个输出
- 非地址首列整行丢弃；行内 `#` 之后的字段停止
- IPv6 保留；loopback 不计入 `entries`
- `setKV` 替换已有键、追加缺失键、不误伤前缀相似的键

### test-status.js

模拟 `ksu.exec` 与最小 DOM，验证交互契约：

- 启动顺序：先 `user-hosts`，再 status + 测量
- 控制台记录了命令、退出码与耗时
- **页面没有发出任何 `.sh` 命令**
- 检测只追加、不写文件
- 已有域名不被覆盖
- 保存时写 user-hosts、两份 hosts，并执行 bind mount
- 国家码写入 config / system.prop，调用 resetprop 与 `cmd wifi`
- 页面不请求扫描，只读系统缓存
- 中文 SSID 穿过 base64 桥接不变乱码
- 诊断报告包含 framework 与 UNII 计数
- 非法国家码被拒绝

测试里的短定时器被压到 0ms；**120 秒的 exec 超时必须保持原值**，否则每个命令都会
在自己的回调之前被超时拒绝。

## 提交前检查

```sh
./build.sh
```

一条命令做完所有事，失败即中止且不产出 zip：

1. `dash -n` 检查 `module/*.sh` 与 `build.sh`
2. 拦截被删除的 6 个脚本复活、页面里出现 `MODDIR + '/...sh'`
3. 校验 `module.prop` 必填字段与 id 首字母
4. 跑 `tests/run.js`（三套并行，约 0.4 秒）
5. 暂存副本里内联 `diag.js`、打包
6. **校验产物本身**：无第二个 `diag.js`、无 `<script src=`、页面调用的函数齐全

只改打包逻辑、不想跑测试时用 `./build.sh --no-test`。

## 脚本规范

模块里只剩三个生命周期钩子，规范相应收窄：

- Shebang 一律 `#!/system/bin/sh`，用 `dash -n` 校验（Android 没有 bash）
- `MODDIR=${0%/*}` 足够：三个钩子都由管理器以绝对路径调用
- 不假设 `curl` / `wget` / `iw` / `getent` 存在，逐项 `command -v` 降级
- 修改挂载前先 `umount`，挂载必须幂等
- 开机日志用 `date '+%Y-%m-%d %H:%M:%S'`，不依赖 awk 的 `strftime`
- 不在脚本里做无上限的 `sleep`
- **不要新增采集/控制脚本**：需要新能力时，先问“这条命令能否由页面直接发”

## WebUI 规范

详细协议见 [WEBUI.md](WEBUI.md)，最低要求：

- **不要写 `import { exec } from 'kernelsu'`**。那是 npm 包，静态页面里会抛
  `Failed to resolve module specifier`，且后续代码不执行，表现为所有状态为空
- 用管理器注入的全局 `ksu.exec(cmd, optsJson, callbackName)`，回调名是字符串
- 模块路径用 `JSON.parse(ksu.moduleInfo()).moduleDir`，不硬编码
- 拿不到 `ksu` 时给出可读提示，不白屏
- 不设页面背景与 `color-scheme`，交给 KernelSU
- 所有 `exec` 都经过 `exec()` 包装，控制台才能看到；不要绕过它直接调 `ksu.exec`
- 输出走 `shRaw()`（`base64` 包装 + `TextDecoder`），否则中文 SSID 会乱码
- 保存只写编辑框里的内容，不做任何探测
- 动作结束后不触发隐藏的全量刷新

## 不要指望 Android 的 awk 和桌面上的一样

页面已经不用 awk 做分析，但排障时仍会在设备上跑 shell：

| 差异 | 表现 |
|---|---|
| 没有 `strftime` | `awk: calling undefined function strftime` |
| 没有数学函数 | `Math support is not compiled in` |
| `gsub` 反斜杠不同 | 同样写法 gawk 输出 `\"`，busybox 输出裸 `"` |

写新命令时优先用 `sed` / `grep` / `cut`，复杂分析放回页面。

## CI

`.github/workflows/build.yml` 只做四件事：

1. checkout + `setup-node`
2. `./build.sh`（上面那 6 步全部在这里，CI 与本地跑的是同一份逻辑）
3. `git diff --exit-code -- module/ tests/` 确认构建没有改源文件
4. 上传 zip；只有推 `v*` tag 时才创建 Release

CI 里不再有第二份检查清单——以前两边各写一遍，改一边忘另一边就会漏。
`dash -n` 取代 `busybox-static` 的 apt 安装，省掉每次跑 CI 的 20 秒。

只有推送 `v*` tag 时才会创建 Release。日常 push main 只跑构建与测试。

## 发布纪律

- **代码可以推 `main`，不要自动打 tag、不要自动发 Release**
- 发布前必须由用户在真机安装测试；测试通过后再决定版本号与 tag
- `module.prop` 的 `version` / `versionCode` 手工递增；zip 文件名来自 `version`
- 当前远程 Releases 只保留既有版本，新增发布需用户明确同意
- 构建产物不入库（`.gitignore` 已忽略 `dist/`），但本地保留供上机测试

## 版本与兼容

- 模块元数据：`module/module.prop`
- 运行配置：`module/config`（只有 `CC`）
- 页面与数据层：`module/webroot/`
- 新增生命周期文件要同时改：`customize.sh` 权限表、`build.sh` 的 `EXEC` 集合
  （CI 复用同一份 `build.sh`，不需要再改第二处）
- 新增运行时文件要确认不会被 `build.sh` 打进包（加入 `SKIP`）
