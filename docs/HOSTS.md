# hosts 编辑与挂载

## 数据流

```
只读：/system/etc/hosts         设备上真正生效的内容，不可编辑
WebUI 编辑框（点「编辑」展开）   一行一个 `IP 域名`，`#` 注释
      │  用户点「保存并应用」
      ▼
module/user-hosts              唯一输入
      │  mergeHosts()：JS 校验 + 去重
      ▼
module/hosts  ──bind mount──▶  /system/etc/hosts
```

页面不做域名探测：没有 `probeAll()`、没有 `curl` 测速、没有 `domains` 读取。
需要哪个地址就填哪个——公共 hosts 里的 IP 对别人快、对你未必，CDN 域名尤其如此，
自动挑出来的“当前最快地址”并不能稳定代表你之后的线路。

## 编辑格式

```
# 注释行
140.82.113.4    github.com
20.205.243.166  github.com
2606:50c0:8000::154  github.com
1.1.1.1         one.one.one.one
```

- 一行一个条目，第一列必须是 IPv4 或 IPv6，否则整行丢弃
- 一行可以带多个域名，逐个展开
- 行内空白可以是空格或制表符
- 中文、引号、制表符都不需要转义：编辑框内容先 `TextEncoder` → base64，
  再由 shell 解码写入，字节原样落盘

## 保存：一个按钮

```
writeFile(user-hosts, 编辑框原文)
mergeHosts(编辑框) → hosts
writeFile(hosts) + writeFile(system/etc/hosts)
chmod 0644 / chown 0:0 / chcon system_file
readlink -f 两个挂载目标 → 页面去重
每个目标：umount + mount -o bind
loadStatus() 读回
```

- 编辑框内容先 `TextEncoder` → base64，再由 shell 解码，字节原样落盘
- 不拼 shell 字符串，所以引号、制表符、中文都不需要转义
- 只有所有写入与至少一次挂载成功才提示完成；否则状态条报失败并指向控制台

## 合并与去重

`mergeHosts()` 是纯 JS：

- 跳过注释与空行
- 第一列必须是 IPv4 或 IPv6，否则整行丢弃
- 同一行多个域名时逐个输出
- **按域名去重，第一条胜出**
- 输出固定头：生成时间、来源说明、`127.0.0.1 localhost`、`::1 localhost ...`
- 只有真正出现用户条目时才写 `# --- user entries ---`，全注释输入不会留下空段

因此 `user`（编辑框里的非注释行数）与 `entries`（实际生效条数）可能不同，
差值就是被去重的行数。

## 配置

模块没有运行配置文件。国家码是框架的运行时状态（`cmd wifi force-country-code`），
不落到任何文件里。

`module/domains` 已不再被读取，保留只为兼容旧版本；可以安全删除。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 保存后没生效 | 挂载失败、SELinux 阻止 | 控制台看 `mounted=0`；`mount.log` 只有开机记录 |
| 条目数比编辑框少 | 同名域名被去重，或行首不是合法 IP | 差值就是被丢弃的行，见「合并与去重」 |
| 加速没感觉 | 应用走 DoT/DoH，绕过 hosts | 关闭系统私人 DNS 再测 |
| 重启后失效 | `post-fs-data.sh` 没跑或 hosts 为空 | 看 `/data/adb/modules/KsuFastSurfing/mount.log` |
