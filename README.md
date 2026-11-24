# ZSpace Memo

基于极空间 NAS 原生独立记事本（`location=2`）的跨平台 Todo 与任务管理工具。

> 当前阶段：**设计评审中（尚未进入编码）**。

## 核心原则

1. **极空间原生笔记是唯一事实来源**：一条普通任务对应一条原生笔记，一个重复系列也只对应一条原生笔记，统一放在 `ZSpace Memo` 专用分类下。
2. **笔记可读、双向兼容**：正文包含人类可读的中文摘要、用户备注和末尾的结构化数据块；官方记事本修改后不能丢失提醒和重复规则。
3. **重复任务区分系列与发生实例**：单条笔记记录规则与完成历史，完成本次自动推进到下一次。
4. **提醒由 NAS 后端独立调度**：部署在极空间 Docker 中的 FastAPI 服务负责计算和推送，不依赖桌面客户端常驻。
5. **一套后端、多端共用**：FastAPI REST `/api/v1` + React/TypeScript（Web/PWA、Tauri 2 Windows/macOS、Homepage 嵌入）。

## 文档导航

- [产品与技术设计（v0.1 草案）](docs/DESIGN.md)：功能结构、任务数据模型、笔记存储格式、重复规则引擎、提醒调度方案、API 与页面交互设计。
- [交互原型（单文件 HTML，浏览器直接打开）](docs/prototype/index.html)
- 原始需求记录：
  - [01-initial.md](docs/requirements/01-initial.md)（v1.0 前期调研与开发需求说明）
  - [02-todo-extension.md](docs/requirements/02-todo-extension.md)（Todo 任务管理功能扩展需求）
  - [03-architecture-notes.md](docs/requirements/03-architecture-notes.md)（三条架构建议补充）
