# 开发

## 环境

| 工具 | 用途 | 备注 |
|---|---|---|
| `python3` | 打包时内联 `diag.js`、写 zip 权限位 | 构建必需 |
| `node` | 跑回归测试 | 不参与打包 |
| `busybox` | `busybox ash -n` 语法检查 | 与 Android 上的 shell 对齐 |
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

- **构建不得修改仓库文件**。旧版本在源文件上原地内联，导致仓库里多出一份 445 行的
  `diag.js` 副本；现在只在暂存副本里做，CI 用 `git diff --exit-code` 校验
- `diag.js` 不进包：产物里的 `index.html` 已经包含它
- 运行日志（`*.log`）不进包
- 同一份源码在任意机器上应得到相同 zip（时间戳与权限位固定）

## 测试

```sh
node tests/test-diag.js
node tests/test-status.js
```

### test-diag.js

纯解析器测试，不碰 DOM 与设备：

- 敌意 SSID：`|`、`=`、引号、反斜杠、`<img onerror>`、中文、`null`
- RSSI 形式：`-51`、`-51(0:-51/1:-56)`
- 表头 / 空行 / 非 WiFi 频段
- UNII 分带：ch36 / 52 / 100 / 144 / 149 / 165
- 链路解析：SSID 含逗号
- 推荐排序：5GHz 优先、DFS 靠后、候选只来自标准栅格
- `collect.sh` 分段：缺段降级、SSID 内 `##` 不算段
- MAC 恢复：前缀后缀匹配、同频回退、6 dB 上限
- `rssiBand` 四档

### test-status.js

模拟 `ksu.exec` 与最小 DOM，验证交互契约：

- 启动顺序：先 `user-hosts`，再 status + collect
- 状态条在所有选项卡之外，不会被局部刷新覆盖
- 检测只追加、不写文件
- 已有域名不被覆盖
- 一个按钮只执行一次 `printf … | base64 -d … && apply`
- 重新扫描能区分“有新结果”与“还是旧缓存”
- 中文 SSID 穿过 base64 桥接不变乱码
- 能力检测的 `yes/no/unknown`
- 非法国家码被拒绝

测试里的 `setTimeout` 被替换为 0ms，避免真等待。

## 提交前检查

```sh
./build.sh
for f in module/*.sh; do busybox ash -n "$f"; done
node tests/test-diag.js
node tests/test-status.js

# 合并去重（首条胜出）
cp -r module /tmp/m
printf '1.1.1.1\tgithub.com\n2.2.2.2\tgithub.com\n' > /tmp/m/user-hosts
sh /tmp/m/manager.sh build
awk '/^[0-9]/{print $2}' /tmp/m/hosts | sort | uniq -d   # 应无输出
awk '$2 == "github.com" {print $1}' /tmp/m/hosts          # 应为 1.1.1.1
```

## 脚本规范

- Shebang 一律 `#!/system/bin/sh`，用 `busybox ash -n` 校验（Android 没有 bash）
- `MODDIR` 统一写法：

  ```sh
  case "$0" in */*) MODDIR=${0%/*} ;; *) MODDIR=. ;; esac
  ```

  `${0%/*}` 在 `sh manager.sh` 这种相对调用下会得到 `manager.sh`
- 不假设 `curl` / `wget` / `iw` / `getent` 存在，逐项 `command -v` 降级
- 写文件走「临时文件 + 校验 + mv」，不做原地覆盖
- 修改挂载前先 `umount`，挂载必须幂等
- 日志用 ASCII，时间戳由 `date '+%H:%M:%S'` 生成；不用 awk 的 `strftime`
- 不在脚本里做无上限的 `sleep`；需要等待时用「退避 + 上限 + 提前退出」

## 不要指望 Android 的 awk 和桌面上的一样

真机上踩过三次：

| 差异 | 表现 |
|---|---|
| 没有 `strftime` | `awk: calling undefined function strftime`，整个报告中止 |
| 没有数学函数 | `Math support is not compiled in`，`10^x`、`log()` 直接失败 |
| `gsub` 反斜杠不同 | 同样写法 gawk 输出 `\"`，busybox 输出裸 `"` |

所以：

- 时间戳由 `date` 生成后用 `-v ts=` 传入
- 功率换算用整数单位连乘
- JSON 转义逐字节循环
- 写新 awk 前先在 `busybox awk` 下跑一遍

## WebUI 规范

详细协议见 [WEBUI.md](WEBUI.md)，最低要求：

- **不要写 `import { exec } from 'kernelsu'`**。那是 npm 包，静态页面里会抛
  `Failed to resolve module specifier`，且后续代码不执行，表现为所有状态为空
- 用管理器注入的全局 `ksu.exec(cmd, optsJson, callbackName)`，回调名是字符串
- 模块路径用 `JSON.parse(ksu.moduleInfo()).moduleDir`，不硬编码
- 拿不到 `ksu` 时给出可读提示，不白屏
- 不设页面背景与 `color-scheme`，交给 KernelSU
- 检测不写文件，保存不偷偷探测
- 动作结束后不触发隐藏的全量刷新

## CI

`.github/workflows/build.yml` 在 push / PR 时：

1. `busybox ash -n` 检查所有脚本
2. 校验 `module.prop` 必填字段
3. `./build.sh`
4. 用空 `user-hosts` 构建一次，确认 hosts 仍有 localhost 且无重复
5. 跑两套 Node 测试
6. 校验包内 `index.html` 自包含、没有 `webroot/diag.js`、页面调用的函数都存在
7. `git diff --exit-code` 确认构建没有改源文件
8. 合成重复域名，验证去重且首条胜出
9. 上传 zip artifact

只有推送 `v*` tag 时才会创建 Release。日常 push main 只跑构建与测试。

## 发布纪律

- **代码可以推 `main`，不要自动打 tag、不要自动发 Release**
- 发布前必须由用户在真机安装测试；测试通过后再决定版本号与 tag
- `module.prop` 的 `version` / `versionCode` 手工递增；zip 文件名来自 `version`
- 当前远程 Releases 只保留既有版本，新增发布需用户明确同意
- 构建产物不入库（`.gitignore` 已忽略 `dist/`），但本地保留供上机测试

## 版本与兼容

- 模块元数据：`module/module.prop`
- 运行配置：`module/config`
- 页面与数据层：`module/webroot/`
- 新增脚本要同时改：`customize.sh` 权限表、`build.sh` 的 `EXEC` 集合、CI 的检查（如适用）
- 新增运行时文件要确认不会被 `build.sh` 打进包（加入 `SKIP`）
