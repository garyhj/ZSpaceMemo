# ZSpace Memo

基于极空间 NAS 原生独立记事本（`location="2"`）的跨平台桌面 Todo 与任务管理工具（Windows / macOS）。

> 当前阶段：**M0 真机兼容性验证已通过，设计已定稿（v0.2），准备进入 M1 编码**。

## 核心原则

1. **极空间原生笔记是唯一事实来源**：一条普通任务对应一条原生笔记，一个重复系列也只对应一条原生笔记，统一放在 `ZSpace Memo` 专用分类下。
2. **零服务端部署，官方 OAuth2 授权**：Tauri 2 桌面端内置官方 `zspace-cli`（`zspace-nas-agent-toolkit`），全程不接触、不存储 NAS 账号密码。
3. **笔记可读、双向兼容**：正文包含人类可读的中文摘要、用户备注和末尾的结构化数据块（`<p>ZSM1:{...}</p>`）；官方记事本修改后不能丢失提醒和重复规则。
4. **重复任务区分系列与发生实例**：单条笔记记录规则与完成历史，完成本次自动推进到下一次。
5. **本地常驻提醒**：开机自启 + 系统托盘常驻调度，弹出 Windows/macOS 原生通知，关机期间错过的提醒在下次开机时自动补发。

## 文档导航

- [产品与技术设计（v0.2）](docs/DESIGN.md)
- [M0 真机兼容性验证记录](docs/COMPATIBILITY.md)
- [交互原型（单文件 HTML，浏览器直接打开）](docs/prototype/index.html)
- 原始需求记录：
  - [01-initial.md](docs/requirements/01-initial.md)
  - [02-todo-extension.md](docs/requirements/02-todo-extension.md)
  - [03-architecture-notes.md](docs/requirements/03-architecture-notes.md)
