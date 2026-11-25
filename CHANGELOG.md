# Changelog

All notable changes to **ZSpace Kit（极空工具箱）** (repository `ZSpaceMemo`) are documented in this file.

## [0.3.3] - 2026-11-25

### Fixed
- **彻底修复悬浮待办窗鼠标移开未自动折叠的问题**：Windows WebView2 下非焦点透明无边框窗口容易丢失 DOM `mouseleave` 事件。现改为在 Rust 后端启用系统级全局鼠标坐标轮询（`win.cursor_position()` + 失焦检测），只要鼠标移出悬浮窗范围即在 ~240ms 内稳定自动折叠回边缘书签；同时新增 `onMouseDown` 保护，避免点击书签时被悬停计时器抢先展开。

## [0.3.2] - 2026-11-25

### Improved & Fixed
- **悬浮待办窗贴边交互区分**：贴边折叠为书签后，鼠标指向即贴边临时展开预览、移开鼠标自动折叠回书签；点击书签或点击「移开固定」按钮则将悬浮窗向内移开一段距离并保持常驻展开。
- **调整工作区切换快捷键**：由 `Ctrl/Cmd + 1 ~ 6` 改为 `Alt + 1 ~ 6`（macOS 为 `Option + 1 ~ 6`），避免与常见截图软件全局快捷键冲突。
- **NAS 状态与消息优化**：`system info` 请求开启 `include_polling: true` 并增强字段兼容（支持 `pool_list` / 实时 CPU 负载 / 内存 / 风扇读取），消除 CPU 负载显示 `-` 的问题；NAS 消息面板默认聚焦「通知」标签。
- **文档文案修正**：修正 README 错别字，同步最新快捷键、悬浮窗交互说明及 `57` 个 IPC 命令统计。

## [0.3.1] - 2026-11-25

### Added
- **文件快传箱（`FileDropView`, `Ctrl/Cmd + 4`）**：支持从桌面直接拖拽文件上传至极空间 NAS（基于 Tauri 2 WebView `onDragDropEvent`），支持目录浏览、新建文件夹、文件名搜索与本地下载保存（`tauri-plugin-dialog`）。
- **NAS 状态看板与消息对接（`NasStatusView`, `Ctrl/Cmd + 5`）**：展示硬件概览、CPU、内存、风扇、磁盘及存储池状态；展示 `system events` 消息流并支持已读标记与自动桥接为系统原生通知（`nas_seen_events` 表去重，支持开关）。
- **Docker 看板（`DockerBoardView`, `Ctrl/Cmd + 6`）**：查看 NAS Docker 容器运行状态与资源占用，支持启动/停止/重启与查看最近 100 行日志。
- **核心适配器 `ToolboxService`**：在 `crates/core/src/toolbox.rs` 封装 `file` / `search` / `system` / `storage` / `docker` CLI 调用。
- **单实例保护**：接入 `tauri-plugin-single-instance`，重复启动程序时自动唤醒并聚焦主窗口。
- **便利贴 800ms 防抖自动保存**：`StickyBoard` 与 `StickyFloatingCard` 输入停止 800ms 后自动同步。
- **悬浮待办窗右键菜单 & 月视图右键快建**：悬浮窗集成 `TaskContextMenu`；月视图右键空白日期格可直接弹出内联快建输入框。

### Fixed
- **Windows 任务栏旧图标缓存**：启动时为主窗体与悬浮窗显式调用 `win.set_icon(...)` 同步刷新运行期窗口图标。
- **屏蔽浏览器原生右键菜单**：全局拦截非输入框与非文本选区外的 WebView 默认右键菜单（“打印/检查”）。

---

## [0.3.0] - 2026-11-24

### Added
- **产品定位升级为 ZSpace Kit（极空工具箱）**：引入可扩展模块注册表 `TOOLBOX_MODULES` 与左侧导航轨（ToolRail）。
- **云便签模块（`StickyBoard` & `StickyFloatingCard`, `Ctrl/Cmd + 3`）**：接入极空间独立记事本 `ZSpace Sticky` 分类（`<p>ZSK1:{...}</p>` 格式），支持 6 色色卡、置顶及独立桌面便利贴浮窗（`sticky-{id}`）。
- **OS 系统原生通知全面替代应用内通知中心**：直接触发 Windows / macOS 原生通知，支持提示音开关、权限检查与发送测试通知。
- **全新品牌图标**：更换全新 `Z` 字形几何科技蓝桌面与托盘图标，修复托盘图标资源与展示问题。

---

## [0.2.8] - [0.2.9] - 2026-11-24

### Changed & Fixed
- **待办悬浮窗全面升级**：标题改为「待办」，展示全部活跃任务并按「已逾期 / 今天 / 本周 / 以后 / 无日期」分组与折叠。
- **修复悬浮窗拖拽**：在 `capabilities/default.json` 中补充 `core:window:allow-start-dragging`，恢复无边框悬浮窗自由拖动。

---

## [0.2.2] - [0.2.7] - 2026-11-24

### Added & Fixed
- **授权白屏修复**：调整 `App.tsx` 中 React Hooks 执行顺序，修复 OAuth 授权成功瞬间的白屏问题。
- **跨窗体实时同步与贴边收起**：主窗口与悬浮窗通过 `tasks:changed` / `tasks:synced` 事件即时刷新；悬浮窗贴边自动折叠为桌面书签条。
- **快捷交互增强**：右键上下文菜单、悬浮操作按钮、键盘快捷键、`TaskDetail` 顶栏编辑、拖拽任务到侧栏清单、撤销 Toast、自定义 24 小时时间选择器及偏好设置。
- **OAuth 进程修复 & CI 自动发布**：保持 `zspace-cli` 子进程管道稳定并隐藏 Windows 控制台窗口；CI 自动在双端构建完成后发布非草稿 GitHub Release。

---

## [0.2.0] - 2026-11-24

### Added
- **M2 / M3 完成**：Tauri 2 桌面主窗口（Dida365 风格三栏布局）、月视图（农历、节气、法定节假日、拖拽改期）、重复规则编辑器与未来发生时间线、多提醒配置、后台 15 秒调度器及 Windows/macOS 安装包自动化打包流水线。

---

## [0.1.0] - 2026-11-24

### Added
- **M0 / M1 完成**：完成真实极空间 NAS 与 Windows 官方客户端往返兼容性验证（[COMPATIBILITY.md](docs/COMPATIBILITY.md)），定稿 `<p>ZSM1:{...}</p>` 元数据格式；实现纯 Rust 核心库 `crates/core`（Codec、重复引擎、提醒计算、SQLite 缓存、`OfficialCliNotebookProvider`）。
