# ZSpace Memo：极空间原生记事本跨平台客户端 / Todo 平台

> 版本：v1.0  
> 文档用途：交给代码型 AI 作为项目开发说明、架构约束和分阶段实施任务。  
> 项目定位：基于极空间 NAS 原生独立记事本的第三方轻量客户端，支持 Todo 管理、桌面快捷记事和 API 集成。

---

## 1. 项目背景与目标

我有一台极空间 NAS，希望基于社区已有的极空间 API/Skill 项目，开发一个属于自己的记事本和 Todo 工具。

极空间 Windows 客户端曾提供过类似桌面悬浮快捷笔记的体验：悬浮窗口编辑的内容实际关联到极空间原生记事本中的一条笔记。希望借鉴这种体验，但不依赖官方客户端内部未公开的悬浮窗口实现，而是自己开发跨平台客户端，直接读写极空间原生记事本。

### 1.1 核心目标

1. **原生数据互通**：自制工具创建、修改的任务，必须能在极空间官方记事本中查看；官方记事本中对这些笔记的修改，也应尽可能被自制工具识别。
2. **一条任务对应一条原生笔记**：采用方案 B。每个 Todo 是极空间原生记事本中的一条独立笔记，不把所有任务塞进一条大笔记。
3. **独立分类隔离**：在极空间原生记事本中新建一个专用分类，例如 `ZSpace Todo`，所有 Todo 笔记统一放在这个分类下，不混入日常普通笔记。
4. **跨平台**：Windows 和 macOS 都提供桌面客户端；Web 端可以通过浏览器/PWA 访问。
5. **统一 API**：后端提供稳定、版本化的 REST API，桌面客户端、Web 端、Homepage 和未来的其他集成都调用同一套 API。
6. **便于扩展**：后续可以把极空间的其他能力模块化暴露出来，例如普通记事本、文件搜索、文件管理、标签、NAS 状态等；第一版不提前实现这些功能。
7. **自托管和私有访问**：优先部署在极空间 NAS 或家庭局域网中可长期运行的设备上，通过局域网/Tailscale 私有访问，不直接暴露 NAS 管理 API 到公网。

### 1.2 非目标（第一版不做）

- 不做多人协作、团队空间、复杂权限系统。
- 不开发另一套独立笔记数据库或独立文件存储。
- 不做复杂项目管理、甘特图、看板、工时统计。
- 不做完整的日历系统或系统级通知中心。
- 不要求第一版支持离线编辑和多端离线冲突合并。
- 不在第一版接入极空间文件管理、影音、相册等其他模块；只预留扩展结构。
- 不依赖官方 Windows/macOS 客户端的内部接口来创建悬浮窗。

---

## 2. 已有项目调研与复用策略

### 2.1 主要基础：zspace_skill

仓库：<https://github.com/coracoo/zspace_skill>

这是本项目的主要底层参考和优先复用对象。仓库当前包含 NAS 协议层、MCP 工具、Skill、FastAPI Dashboard 等组件；记事本 MCP 工具按仓库文档列出 17 个操作，Dashboard 也有记事本相关页面和数据路由。

重点参考目录/文件（实际开发时请重新检查仓库最新代码和依赖版本）：

- `nas/`：NAS 登录、请求协议、客户端封装。
- `nas/client.py`：`NasClient`，负责登录态、HTTP 请求和 Token 失效后的重新登录。
- `zspace/mcp_server/tools/notebook.py`：极空间原生记事本的读写操作封装。
- `dashboard/app/routes/notebook.py`：已有 FastAPI 记事本路由，可作为参数和接口实现参考。
- `dashboard/`：现有 Web Dashboard，可用于理解已有界面及会话处理方式。

目前已从仓库源码确认的记事本操作包括：

- 查询列表、详情、搜索。
- 获取分类树、分类列表、笔记统计和配置。
- 新建、修改、删除笔记。
- 置顶、更新标签、移动分类。
- 新建、删除、重命名分类。
- 查询历史版本列表/详情。

关键兼容规则：

1. 独立记事本使用 `location=2`；`location=1` 是保险箱备忘录，不是本项目目标。
2. 笔记正文使用 HTML；已有源码明确提示，提交的 `body` 必须以 `<h1>{title}</h1>` 开头，否则可能出现 NAS 未正确保存正文的问题。
3. 笔记分类绑定使用叶子分类 ID。列表按分类查询时，`classify_id` 查询的是笔记直属分类，不保证递归包含子分类。
4. `classify_id=0` 表示全部/未分类语义，`classify_id=-1` 表示最近删除；具体列表返回结构需要在实际 NAS 上联调确认。
5. 删除接口有风险：第一次删除会进入最近删除，第二次可能永久删除。因此 Todo 的“完成”绝不能通过删除实现；普通删除操作应二次确认。
6. `NasClient` 当前实现依赖环境变量中的 NAS 用户名/密码，并负责登录态管理；新设备登录可能需要极空间侧额外验证或使用已登记设备信息。开发时必须实际验证，不要把登录成功视为必然。

建议复用 `zspace_skill` 的 NAS 协议和记事本 API 封装，但不要把 MCP 当作前端的业务通信协议。优先在其 NAS 客户端之上编写本项目自己的 Service/Adapter，再由 FastAPI 暴露独立、稳定的 REST API。

### 2.2 辅助参考：zspace-cli

仓库：<https://github.com/skyzhao1223/zspace-cli>

该项目提供极空间 NAS 的 CLI、Python SDK 和可选 MCP，重点偏向文件系统、目录、上传下载、文件搜索和 NAS 信息。当前 README 所描述的使用方式要求极空间桌面客户端在 macOS 上运行并保持登录态。

因此：

- 不把 `zspace-cli` 作为本项目记事本功能的核心依赖。
- 第一版只需要 `zspace_skill` 已经具备的记事本 API 能力。
- 将来扩展 NAS 普通文件相关能力时，再评估是否复用 `zspace-cli` 的 SDK/CLI。
- 不要为了“两个项目都用上”而强行引入多套 NAS 登录机制。

### 2.3 对现有项目的使用原则

- 开发前先拉取两个仓库的最新代码，确认目录、函数签名和依赖版本，不能仅凭本说明中的文件路径直接假设代码未变化。
- 优先复用协议层、登录态和记事本操作，不必复用现有 Dashboard 的页面结构。
- 对上层封装统一的 `NotebookProvider` 接口，避免业务逻辑直接依赖仓库内部函数名。
- 如果采用复制代码或 Fork，请遵守原仓库 MIT License，并保留相应版权/许可声明。
- 不要把 NAS 用户名、密码、Token、Cookie 写进前端代码、桌面安装包、日志或 API 响应。

---

## 3. 核心数据设计：一条 Todo 对应一条极空间原生笔记

### 3.1 原生分类

在极空间原生独立记事本（`location=2`）中创建一个专用顶级分类：

```text
ZSpace Todo
```

也可以在界面中显示为“待办任务”，名称允许在设置中修改。

第一版建议使用**单个顶级分类，任务笔记直接归属该分类，不再创建子分类**。原因是现有接口按叶子分类 ID 查询，父分类不一定会自动递归包含子分类；单层结构更容易保证列表完整性。

服务启动或首次配置时：

1. 读取极空间原生记事本完整分类树。
2. 检查配置的 Todo 分类是否存在。
3. 如果不存在，提供“创建专用分类”操作；允许用户确认后创建。
4. 保存返回的分类 ID 到本项目配置。
5. 后续启动优先检查已保存 ID 是否仍有效；不要每次启动都新建分类。
6. 如果用户在官方客户端中重命名分类，按 ID 识别，不应因名称改变就创建重复分类。
7. 如果分类被删除或 ID 无效，进入配置异常状态，提示重新选择/创建，不得静默把任务写入“全部”或普通分类。

### 3.2 任务与笔记的映射

每条 Todo 对应一条独立原生笔记：

| Todo 概念 | 极空间笔记字段/实现 |
|---|---|
| 任务 ID | 极空间原生笔记 `id` |
| 任务标题 | 笔记 `title` |
| 任务描述/备注 | 笔记 HTML `body` 中的描述区域 |
| 所属任务分类 | 固定 `classify_id`（专用 Todo 分类 ID） |
| 标签 | 优先复用原生笔记 `label` |
| 置顶 | 原生 `pin_flag` |
| 创建/更新时间 | 尽可能使用原生笔记返回的时间字段 |
| 完成状态 | 存在笔记正文中的 Todo 元数据，不使用删除或移动到其他分类实现 |
| 截止日期 | 存在笔记正文中的 Todo 元数据 |
| 优先级 | 存在笔记正文中的 Todo 元数据 |

注意：当前已确认的原生笔记接口没有单独的 Todo 状态、截止日期、优先级字段。因此这些扩展字段需要编码在笔记 HTML 正文中，并由本项目解析。**不要未经验证就假设极空间有独立的任务字段。**

### 3.3 正文格式约定

所有由本工具创建的任务正文使用统一、可读、可解析的 HTML 约定。必须以标题 H1 开头：

```html
<h1>续费 eSIM</h1>
<div class="zspace-todo-meta">
  <p><strong>任务状态：</strong>pending</p>
  <p><strong>截止日期：</strong>2026-11-26</p>
  <p><strong>优先级：</strong>normal</p>
  <p><strong>完成时间：</strong></p>
</div>
<hr>
<div class="zspace-todo-description">
  <p>需要确认套餐和充值金额。</p>
</div>
```

建议元数据枚举：

- `status`：`pending` / `completed`。
- `due_date`：`YYYY-MM-DD`，允许为空。
- `priority`：`low` / `normal` / `high` / `urgent`。
- `completed_at`：ISO 8601 时间，允许为空。
- 正文描述：自由 HTML，允许为空。

实现注意：

1. 上述 HTML 是建议的数据约定，必须在真实极空间 NAS 上验证：创建后官方记事本能否正常显示；官方记事本编辑并保存后，这些标记是否保留；API 读回后能否稳定解析。
2. 不要依赖 HTML 注释、隐藏脚本或浏览器私有状态来保存元数据。优先使用官方编辑器也能正常显示的普通 HTML 内容。
3. 元数据区域可以在本项目 UI 中美化/折叠，但官方记事本中应当仍然可读。
4. 解析器必须容错：老笔记、用户手工创建的普通笔记、格式不标准的正文不能导致整个列表加载失败。
5. 如果笔记正文中没有合法的 Todo 元数据，但它位于专用 Todo 分类中，则默认识别为待办任务；正文剩余内容作为描述，用户首次编辑保存时再补齐元数据格式。
6. 保留未识别的 HTML 内容。编辑任务时不得因为解析失败而清空用户原有正文。
7. 如果官方编辑器会重排 HTML，请使用稳定的语义标签/字段解析方式，不要完全依赖字符串位置；开发阶段必须做往返读写测试。

### 3.4 完成、归档、删除的语义

- **完成**：修改同一条笔记正文中的 `status=completed` 和 `completed_at`；笔记仍留在 `ZSpace Todo` 分类中。
- **重新打开**：把状态改回 `pending`，清空 `completed_at`。
- **归档**：第一版可以先不做独立归档机制；可用已完成筛选视图代替。后续如需归档，再增加明确的归档标记或归档分类策略。
- **删除**：调用原生笔记删除接口，前端必须提示这是删除操作，并说明原生接口存在“最近删除/永久删除”的行为。完成任务不能调用删除接口。

---

## 4. 产品形态与整体架构

### 4.1 产品形态

一套前端、多种入口：

1. **Web 端**：浏览器直接访问；同时可做 PWA，方便手机添加/查看任务。
2. **Windows 桌面端**：轻量悬浮窗口、系统托盘、快捷键呼出、置顶、开机启动。
3. **macOS 桌面端**：与 Windows 共用前端和业务逻辑，支持菜单栏/状态栏入口、快捷键呼出、窗口置顶等系统能力。
4. **Homepage 集成**：提供专用嵌入页面和标准 API。Homepage 支持 iframe 时可嵌入“今日待办/快速添加”精简页面；不支持时使用链接卡片或由 Homepage 自身的自定义组件请求 API。

桌面端不直接登录 NAS，也不直接持有 NAS 密码；只访问本项目后端。

### 4.2 推荐架构

```text
                 ┌──────────────────────────────┐
                 │         统一前端              │
                 │                              │
                 │  Web / PWA                   │
                 │  Windows Desktop (Tauri 2)   │
                 │  macOS Desktop (Tauri 2)     │
                 │  Homepage Embed              │
                 └──────────────┬───────────────┘
                                │ HTTPS / REST JSON
                                ▼
                 ┌──────────────────────────────┐
                 │       FastAPI Backend        │
                 │                              │
                 │  API v1 / Auth / Config      │
                 │  Task Service                │
                 │  Notebook Service            │
                 │  Capability Modules          │
                 └──────────────┬───────────────┘
                                │
                                ▼
                 ┌──────────────────────────────┐
                 │    ZSpace Notebook Adapter   │
                 │                              │
                 │  NotebookProvider Interface  │
                 │  zspace_skill NasClient      │
                 │  location = 2                │
                 └──────────────┬───────────────┘
                                │ ZSpace NAS API
                                ▼
                 ┌──────────────────────────────┐
                 │       极空间 NAS Z4          │
                 │   原生独立记事本 / ZSpace Todo│
                 │     一条任务 = 一条笔记       │
                 └──────────────────────────────┘
```

### 4.3 后端部署位置

优先考虑 Docker Compose 部署在极空间 NAS 上；如果极空间当前环境不适合运行该服务，也可以部署在家庭其他常驻设备上（例如另一台 NAS 或家庭服务器），只要该设备能通过局域网/Tailscale 访问极空间即可。

服务需要：

- 持久化配置目录。
- 安全保存 NAS 连接凭据和本项目 API 密钥。
- 健康检查、日志轮转和基本错误日志。
- 容器重启后恢复连接，不重复创建 Todo 分类。
- 不要求 Docker 容器挂载极空间内部记事本数据目录；通过 NAS API 访问即可。

### 4.4 技术栈建议

优先采用以下方案，除非开发前发现明确技术障碍：

| 层 | 推荐 | 原因 |
|---|---|---|
| 后端 | Python + FastAPI | 与 `zspace_skill` 的 Python/NAS 客户端体系衔接自然，REST/OpenAPI 方便 |
| 前端 | React + TypeScript + Vite | Web、PWA、桌面端共用 UI 和 API 客户端 |
| UI | Tailwind CSS + 轻量组件库 | 适合紧凑、简洁、跨端适配的任务列表 |
| 桌面壳 | Tauri 2 | 同一套 Web 前端构建 Windows/macOS 桌面程序，系统集成能力通过插件/命令实现 |
| API | REST + JSON，路径版本化 `/api/v1` | 方便 Homepage、浏览器和未来第三方客户端接入 |
| 部署 | Docker Compose | 服务端统一部署、升级和重启 |

不要在第一版采用微服务。先用清晰分层的单体 FastAPI 服务即可。

---

## 5. 后端设计要求

### 5.1 分层

建议按职责拆分，不要把所有业务写进一个路由文件：

```text
backend/
  app/
    main.py
    api/
      v1/
        health.py
        tasks.py
        settings.py
        integrations.py
    core/
      config.py
      security.py
      logging.py
    services/
      task_service.py
      notebook_service.py
      category_service.py
    providers/
      base.py                 # NotebookProvider 抽象接口
      zspace/
        adapter.py            # 基于 zspace_skill/NasClient
        html_codec.py         # Todo 元数据 HTML 编码/解析
    models/
      task.py                 # API DTO/Pydantic 模型
    repositories/
      config_repository.py    # 只保存本项目配置，不存任务正文
```

目录可根据实际仓库整合，但必须保留“API 路由 / 业务服务 / NAS Provider”边界。

### 5.2 NotebookProvider 抽象

至少定义以下操作，以便未来替换或扩展底层来源：

- `health_check()`
- `list_categories()`
- `create_category(name, parent_id=0)`
- `list_notes(category_id, page/limit)`
- `get_note(note_id)`
- `create_note(title, html_body, category_id)`
- `update_note(note_id, title, html_body)`
- `move_note(note_id, category_id)`
- `set_note_labels(note_id, labels)`
- `set_note_pin(note_id, pinned)`
- `delete_note(note_id)`

Provider 必须统一处理 `location=2`、NAS Token 续期、异常转换、请求超时和返回值校验。不要让前端知道 NAS 原始接口的路径、表单字段或 Cookie 格式。

### 5.3 本项目 REST API（建议契约）

所有 API 前缀：`/api/v1`。统一 JSON 响应和错误格式。以下为建议契约，实际实现时请生成 OpenAPI 文档。

| Method | Path | 用途 |
|---|---|---|
| GET | `/health` | 服务健康状态 |
| GET | `/integrations/zspace/status` | NAS 登录、连通性、Todo 分类状态 |
| GET | `/settings` | 读取非敏感配置 |
| GET | `/tasks` | 获取任务列表；支持 `status`、`due`、`keyword`、`limit`、`cursor` 等查询参数 |
| GET | `/tasks/{id}` | 获取任务详情 |
| POST | `/tasks` | 创建任务并创建一条极空间原生笔记 |
| PATCH | `/tasks/{id}` | 修改标题、描述、状态、截止日期、优先级、标签等 |
| POST | `/tasks/{id}/complete` | 标记完成 |
| POST | `/tasks/{id}/reopen` | 重新打开 |
| POST | `/tasks/{id}/pin` | 置顶/取消置顶 |
| DELETE | `/tasks/{id}` | 删除原生笔记，必须有前端确认 |
| POST | `/settings/todo-category/initialize` | 检查/创建 Todo 专用分类，必须避免重复创建 |

建议任务 JSON：

```json
{
  "id": 12345,
  "title": "续费 eSIM",
  "description": "确认套餐和充值金额",
  "status": "pending",
  "due_date": "2026-11-26",
  "priority": "normal",
  "labels": ["个人", "续费"],
  "pinned": false,
  "created_at": "2026-11-24T10:00:00+08:00",
  "updated_at": "2026-11-24T10:00:00+08:00",
  "completed_at": null,
  "source": "zspace_notebook"
}
```

说明：`id` 是极空间笔记原生 ID，不另造任务 ID。时间字段优先使用 NAS 实际返回的数据；如果某字段原生接口没有可靠值，明确返回 `null`，不要伪造。

### 5.4 API 稳定性

- API 采用 `/api/v1` 版本前缀。
- 前端不得直接调用极空间 `:5055` 的 API。
- 所有 NAS 原始错误转换为可读的本项目错误码和消息；保留内部日志用于排查。
- 写操作应校验 NAS 返回码，不能只要 HTTP 200 就当成功。
- 创建笔记后必须读取一次新笔记，确认标题、正文、分类 ID 和元数据均正确保存，再向前端返回成功。
- 修改笔记前建议重新读取最新正文；如果 NAS 有更新时间字段，比较客户端读取版本与当前版本，发现外部修改时提示冲突，避免直接覆盖官方客户端刚刚保存的内容。
- 列表应分页，不要一次性拉取全部笔记。
- 为 Homepage 的轻量展示提供精简响应，避免加载完整富文本详情。

---

## 6. 前端功能范围

### 6.1 第一版核心页面

1. **收集箱/全部任务**：展示所有待办任务，支持快速新增。
2. **今天**：按截止日期展示今天到期的任务；没有截止日期的任务不应被误判为今天到期。
3. **即将到期**：展示未来一段时间到期的任务。
4. **已完成**：展示 `status=completed` 的任务。
5. **搜索**：按标题、描述和标签搜索。优先由后端调用极空间笔记搜索/或读取任务列表后进行过滤；需根据 NAS 搜索实际覆盖范围验证。
6. **任务详情/编辑**：标题、描述、状态、截止日期、优先级、标签、置顶。
7. **设置**：NAS 连接状态、Todo 专用分类、API 访问设置、前端主题等。

### 6.2 快速新增

- 页面顶部提供单行快速输入框。
- 输入任务标题后按 Enter 即可新增。
- 新任务默认状态 `pending`、优先级 `normal`、截止日期为空。
- 成功创建后立即显示在列表顶部。
- 新增时必须写入 Todo 专用分类 ID。
- 新建失败时保留用户输入内容，并提示具体原因。

### 6.3 任务交互

- 点击复选框：完成/重新打开。
- 点击标题：打开详情。
- 可快速设置截止日期和优先级。
- 支持置顶。
- 支持标签。
- 删除与完成严格区分。
- 支持按状态、截止日期、优先级筛选和排序。

### 6.4 视觉与交互风格

- 简洁、轻量、紧凑，避免复杂项目管理软件的臃肿感。
- 桌面端适合窄窗口和悬浮窗口。
- Web 端响应式布局，手机上可以单手快速录入和勾选。
- 主要操作尽量一步完成，减少多层弹窗。
- 同步状态清晰：加载中、已保存、保存失败、NAS 离线、发生外部修改。
- 不要在 UI 中展示 NAS 密码、Token 或 Cookie。

---

## 7. Windows / macOS 桌面端要求

桌面端基于 Tauri 2，共用 React/TypeScript 前端和后端 REST API，不分别开发两套客户端。

### 7.1 第一版必须具备

- Windows x64 安装包。
- macOS Apple Silicon 安装包；如构建条件允许，再提供 Intel 版本。
- 可配置后端 API 地址。
- 登录/保存本项目访问凭据（安全存储，不写明文配置文件）。
- 普通主窗口。
- 窄窗口/快捷记事模式。
- 系统托盘或 macOS 菜单栏入口。
- 关闭窗口时可隐藏到托盘（设置可关闭此行为）。
- 快捷键显示/隐藏窗口（允许用户配置或至少提供默认快捷键）。

### 7.2 第二阶段增强

- 悬浮窗口始终置顶。
- 开机自启动。
- 快捷键呼出后自动聚焦快速输入框。
- 窗口记忆上次位置和尺寸。
- 剪贴板快速收集。
- 桌面通知（只在用户主动开启时启用）。

Windows 和 macOS 的系统托盘、快捷键、开机启动等实现可以存在平台差异，但业务逻辑和任务数据处理必须共用。

---

## 8. Web / PWA / Homepage 集成

### 8.1 Web/PWA

- Web 端直接访问部署在家庭网络中的后端。
- 可安装为 PWA，便于手机主屏幕访问。
- 第一版不承诺离线写入；NAS/后端不可用时明确显示离线状态。
- 未来如增加离线草稿，必须与原生笔记同步冲突策略分开设计。

### 8.2 Homepage 嵌入

提供一个极简嵌入路由，例如：

```text
/embed/today
```

页面只展示：

- 今日待办数量。
- 今日任务列表。
- 快速新增输入框。
- 查看全部任务的入口。

嵌入页不显示完整侧边栏和复杂设置，适合放在 Homepage 的一个卡片/面板中。

安全要求：

- 如果 Homepage 和 ZSpace Memo 通过同一反向代理域名下的不同路径访问，优先使用同源路径代理，减少跨域和 Cookie 问题。
- 如果需要 iframe，服务端 CSP `frame-ancestors` 只允许明确配置的 Homepage 来源；不要全局允许任意网站嵌入。
- CORS 只允许明确配置的来源。
- 不允许把长期 API Token 放在 URL 查询参数中。
- Homepage 不支持 iframe 时，提供普通链接入口或由其自定义 Widget 调用 REST API。
- 嵌入页和 API 都必须经过访问控制，不得因为“只是家庭内网”就完全无鉴权。

---

## 9. 安全、配置与运维

### 9.1 凭据管理

至少区分两类凭据：

1. **极空间 NAS 凭据**：仅后端持有，用于登录 NAS；保存在服务端环境变量或受保护的配置文件中。
2. **ZSpace Memo API 凭据**：供 Web、桌面和外部集成访问本项目 API；与 NAS 密码完全分离，可单独生成和撤销。

要求：

- NAS 密码、Token、Cookie 不进入浏览器或桌面前端构建产物。
- 日志中对账号、Token、Cookie、密码做脱敏。
- API 默认只绑定内网接口或通过反向代理/Tailscale 提供访问。
- 不建议直接将 NAS 的 `:5055` 管理 API 暴露到公网。
- 使用 HTTPS；通过 Tailscale 私有访问时仍应保留应用层鉴权。
- 提供 API Token 轮换/撤销能力，最初可以是单用户管理员 Token。

### 9.2 配置项示例

```env
# 极空间 NAS
NAS_HOST=192.168.x.x
NAS_USER=your_username
NAS_PASSWORD=your_password
NAS_DEVICE_ID=                  # 如登录流程需要已登记设备 ID

# 本项目
APP_HOST=0.0.0.0
APP_PORT=8088
APP_SECRET=replace_with_random_secret
API_TOKEN=replace_with_long_random_token
TODO_CATEGORY_NAME=ZSpace Todo
TODO_CATEGORY_ID=
ALLOWED_ORIGINS=https://homepage.example
ALLOWED_FRAME_ANCESTORS=https://homepage.example
TIMEZONE=Asia/Shanghai
```

配置文件只作为格式示例，实际密钥必须由部署者生成；不要将 `.env` 提交到 Git。

### 9.3 运维

- 提供 Dockerfile 和 docker-compose.yml。
- 配置持久化目录，例如 `/app/data`，用于保存应用设置和密钥文件（如果采用文件配置）。
- 提供 `/api/v1/health` 健康检查。
- 提供结构化日志和日志级别配置。
- 服务重启后应能自动检查 NAS 连接和分类状态。
- 不应因 NAS 暂时离线而清空本地配置或自动创建第二个分类。
- 配置和缓存可备份；任务主体数据以极空间原生笔记为准。

---

## 10. 数据一致性与异常处理

这是项目最重要的技术风险之一，因为极空间原生记事本也可能被官方 Windows/macOS/手机客户端同时编辑。

### 10.1 数据源原则

- 极空间原生笔记是任务主体的唯一事实来源。
- 不创建第二份完整任务数据库。
- 可以建立短期缓存或搜索索引，但必须能够随时从 NAS 重建。
- 本地配置只存 NAS 连接配置、Todo 分类 ID、应用访问设置等，不把缓存当成最终数据。

### 10.2 并发修改

- 编辑任务时先读取最新笔记。
- 修改请求带上前端读取时的 `updated_at` 或内容摘要（如果原生返回字段足够可靠）。
- 写入前再次读取并比较；发现官方客户端已修改时，提示用户刷新/对比，不应静默覆盖。
- 如果 NAS 不提供可靠版本字段，至少在 UI 进行“保存前重新读取并比较正文”的保护。
- 创建/更新成功后重新读取校验。

### 10.3 外部编辑兼容

- 用户在官方记事本中新增到 `ZSpace Todo` 分类的笔记，应可被本工具发现。
- 这类笔记若没有 Todo 元数据，默认按未完成任务展示。
- 用户在官方记事本中修改标题/正文后，本工具下一次刷新应显示最新内容。
- 官方编辑器可能会格式化 HTML；必须测试元数据区域在官方编辑器往返保存后是否稳定。
- 对无法识别的正文保留原始内容，不能为了符合格式而丢弃用户输入。

### 10.4 缓存与刷新

- 第一版可采用短时间内存缓存或轻量缓存，避免频繁请求 NAS。
- 写操作成功后立即清除/更新相关缓存。
- 提供手动刷新。
- 客户端可设置合理轮询间隔；不要每秒轮询 NAS。
- 后续如 NAS 有可用变更通知机制，再考虑事件推送；第一版不假设存在 WebSocket/事件订阅接口。

---

## 11. 分阶段开发计划

请严格按阶段交付，每阶段完成后都能独立运行和验证，不要一次性堆叠所有功能。

### Phase 0：源码检查与真实 NAS 验证

目标：确认技术链路成立，不急着写完整 UI。

任务：

1. 拉取 `zspace_skill` 和 `zspace-cli` 最新代码，梳理可复用部分和依赖。
2. 在真实极空间 NAS 上登录，确认 `location=2` 的独立记事本操作。
3. 创建一个临时测试分类，例如 `ZSpace Memo Test`。
4. 新建一条测试笔记，确认返回原生笔记 ID。
5. 通过原生记事本 App 查看该笔记内容。
6. 用 API 修改笔记，再通过官方记事本确认内容同步。
7. 在官方记事本修改该笔记，再通过 API 读取确认反向可见。
8. 验证 HTML 元数据约定在官方编辑器保存后是否保留。
9. 验证分类查询只取直属笔记的行为、分页行为和删除到最近删除的行为。
10. 输出一份验证记录，列出成功项、失败项和需要调整的字段/接口。

验收标准：必须证明“本项目 API 写入的原生笔记，官方极空间记事本可以看到；官方修改后，本项目 API 可以读取到”。未通过前不要进入完整 Todo UI 开发。

### Phase 1：后端最小可用版本

范围：

- NAS 登录和状态检查。
- Todo 专用分类检查/创建。
- 任务列表、详情、新建、编辑、完成、重新打开、置顶、删除。
- HTML 元数据编码和解析。
- `/api/v1` REST API。
- API 鉴权、OpenAPI 文档、错误处理。
- Docker Compose 部署。

验收标准：可以只通过 curl/Postman 完成一整套任务 CRUD，且所有记录都能在极空间原生记事本中查看。

### Phase 2：Web/PWA 前端

范围：

- 全部任务、今天、即将到期、已完成、搜索。
- 快速新增、任务勾选、详情编辑。
- 设置页面和 NAS 状态。
- 响应式手机布局。
- PWA 安装能力。

验收标准：浏览器与手机 PWA 使用同一后端，新增/修改后官方记事本数据同步一致。

### Phase 3：Windows/macOS 桌面客户端

范围：

- Tauri 2 封装。
- Windows/macOS 构建流水线。
- 主窗口、窄窗口/快捷记事窗口、托盘/菜单栏。
- 快捷键、窗口置顶、关闭到托盘。
- 后端地址和应用 API 凭据设置。

验收标准：同一套前端业务代码能在 Windows 和 macOS 使用，桌面端无需单独保存 NAS 账号密码。

### Phase 4：Homepage 集成

范围：

- `/embed/today` 极简嵌入页面。
- frame-ancestors 和 CORS 白名单配置。
- 同源反代/登录策略文档。
- 如 Homepage 支持，嵌入今日任务；否则提供卡片链接/REST API 接入说明。

验收标准：Homepage 能以安全方式展示今日待办并快速添加任务。

### Phase 5：后续能力扩展（不纳入第一版）

后续可以逐步增加独立模块，例如：

- 普通极空间记事本管理（不局限于 Todo 分类）。
- NAS 文件搜索/文件信息查询。
- 标签管理。
- NAS 状态、磁盘和存储池监控。
- 简单的 Webhook/自动化接口。
- 提供给 AI Agent 的 MCP Server，让 AI 可以通过同一套业务服务创建/查询任务。

扩展原则：所有新能力通过独立 Provider/Service/API 模块加入；客户端仍然调用统一 API。不要把所有 NAS API 一次性搬进本项目。

---

## 12. 第一版验收清单

### 原生数据互通

- [ ] 可以连接真实极空间 NAS。
- [ ] 使用 `location=2`，不是保险箱备忘录。
- [ ] 可以创建并识别唯一的 `ZSpace Todo` 专用分类。
- [ ] 一条任务对应一条原生笔记，并保存原生笔记 ID。
- [ ] 本工具创建的笔记能在官方记事本看到。
- [ ] 官方记事本编辑的内容能被本工具重新读取。
- [ ] 官方编辑器保存后，任务状态/截止日期等元数据可正确解析，或有明确降级处理。

### Todo 功能

- [ ] 新建、查看、编辑、删除任务。
- [ ] 完成/重新打开任务，不通过删除实现。
- [ ] 截止日期、优先级、标签。
- [ ] 今天、即将到期、已完成筛选。
- [ ] 支持搜索、分页和手动刷新。
- [ ] 对普通/旧格式笔记有容错能力。

### API 与安全

- [ ] 统一 `/api/v1` REST API。
- [ ] OpenAPI 文档。
- [ ] 独立 API 鉴权。
- [ ] NAS 密码和 Token 不进入前端。
- [ ] CORS 和 iframe 来源白名单。
- [ ] 日志脱敏。
- [ ] 写操作校验 NAS 业务返回码。

### 多端与部署

- [ ] Docker Compose 可部署后端。
- [ ] Web/PWA 可访问。
- [ ] Windows Tauri 桌面端可运行。
- [ ] macOS Tauri 桌面端可运行。
- [ ] Homepage 可通过嵌入页或 API 集成。
- [ ] 桌面端和 Web 端操作的是同一批原生笔记。

---

## 13. 给代码型 AI 的开发指令

请你作为资深全栈工程师，基于本说明实施项目。不要只输出方案，请实际创建代码、配置、测试和部署文件。

开发时遵循以下要求：

1. **先做 Phase 0**。先阅读两个 GitHub 仓库最新代码，重点分析 `zspace_skill` 的 NAS 登录、`NasClient`、记事本 MCP 工具和 Dashboard 路由。不要凭 README 猜参数。
2. 先给出简短的技术实现计划和仓库目录设计，然后直接开始实现；不要反复询问已经在本说明中明确的需求。
3. 如果某个接口/字段不确定，先用真实 NAS 或可控测试环境验证，并把验证结果写入 `docs/COMPATIBILITY.md`；不得伪造接口能力。
4. 先保证“原生笔记读写互通”，再开发 UI。
5. 任务的真实数据必须保存在极空间原生独立记事本的专用分类中；不得将 SQLite/其他数据库作为任务主库。SQLite 如有必要，只能用于配置、缓存或可重建索引，并明确边界。
6. 后端统一封装 `NotebookProvider`，前端只调用本项目 REST API。
7. 第一版采用单体 FastAPI，不做微服务，不引入不必要的基础设施。
8. Web、Windows、macOS 共用 React/TypeScript 前端；桌面壳使用 Tauri 2。
9. 提供 Docker Compose、`.env.example`、README、API 文档、兼容性说明和基本自动化测试。
10. 对 NAS 密码、Token、Cookie 做严格保护，不得输出到前端、日志或提交到 Git。
11. 每个阶段完成后运行测试，报告实际通过/未通过的项目，不要声称未测试的功能已经可用。
12. 代码要有清晰类型、错误处理、日志和必要注释；不要为了赶进度把所有逻辑堆在单个文件。

**第一阶段最终交付物：**

- 能运行的 FastAPI 后端。
- 极空间原生记事本适配器。
- Todo 专用分类初始化功能。
- `/api/v1/tasks` 等核心接口。
- HTML 元数据编解码器和测试。
- Docker Compose 部署配置。
- `README.md`、`docs/COMPATIBILITY.md`、`docs/API.md`。
- 一份真实 NAS 读写互通验证记录。

在第一阶段交付并验证后，再继续 Web/PWA、Tauri 桌面端和 Homepage 集成。

---

## 14. 参考仓库与关键源码

- `zspace_skill`：<https://github.com/coracoo/zspace_skill>
- `zspace_skill` 记事本 MCP 工具：<https://github.com/coracoo/zspace_skill/blob/master/zspace/mcp_server/tools/notebook.py>
- `zspace_skill` Dashboard 记事本路由：<https://github.com/coracoo/zspace_skill/blob/master/dashboard/app/routes/notebook.py>
- `zspace_skill` NAS 客户端：<https://github.com/coracoo/zspace_skill/blob/master/nas/client.py>
- `zspace-cli`：<https://github.com/skyzhao1223/zspace-cli>

本说明中的仓库能力描述以调研时可见的公开 README 和源码为依据。GitHub 仓库会持续变化，正式开发前必须以实际拉取的最新代码为准。
