# 文档索引

这套文档既服务于使用者，也服务于**接续开发**：新会话不必重新读一遍全部代码，
按下面的顺序读就能接上当前状态。

## 推荐阅读顺序

| 顺序 | 文档 | 什么时候读 |
|---|---|---|
| 1 | [HANDOFF.md](HANDOFF.md) | 接手项目、继续上一轮工作、确认哪些事不能做 |
| 2 | [ARCHITECTURE.md](ARCHITECTURE.md) | 改数据层、加命令、理解开机流程与数据流 |
| 3 | [WEBUI.md](WEBUI.md) | 改页面、加交互、调桥接与状态条 |
| 4 | [DIAGNOSTICS.md](DIAGNOSTICS.md) | 改扫描解析、信道评分、DFS / MAC 脱敏 |
| 5 | [HOSTS.md](HOSTS.md) | 改编辑格式、hosts 合并与保存 |
| 6 | [DEVELOPMENT.md](DEVELOPMENT.md) | 构建、测试、提交前检查、发布纪律 |
| 7 | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | 按现象排查挂载、MAC、国家码与页面问题 |

## 按任务找文档

| 想做的事 | 先看 |
|---|---|
| 搞清楚模块开机做了什么 | ARCHITECTURE · 生命周期 |
| 改 hosts 合并 / 去重 / 挂载 | ARCHITECTURE · hosts 管线；HOSTS |
| 改 hosts 编辑与保存流程 | HOSTS |
| 改信道评分、DFS 判断 | DIAGNOSTICS |
| 改页面布局、按钮、状态提示 | WEBUI |
| 加一条设备命令 | ARCHITECTURE · 控制面；WEBUI · 桥接协议 |
| 打包 / 跑测试 / 发版前检查 | DEVELOPMENT |
| 用户报告某个现象不正常 | TROUBLESHOOTING |
| 确认当前版本、待办、已知限制 | HANDOFF |

## 文档维护约定

- 行为变化时，**先改代码与测试，再改对应文档**；HANDOFF 的“当前状态”每次收尾都更新
- README 只放项目介绍、安装、功能概览与文档入口，不写实现细节
- 文档中的命令、路径、字段名以仓库当前代码为准；不确定的写“未验证”，不写推测
- 不在文档里记录 token、密钥、本机路径等与环境绑定的信息
