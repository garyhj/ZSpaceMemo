# Changelog

All notable changes to **ZSpace Kit（极空工具箱）** (repository `ZSpaceMemo`) are documented in this file.

## [0.4.2] - 2026-11-26

### Fixed
- **修复文件快传箱把文件误判为文件夹导致全部显示「子目录已锁定」的 Bug**：
  - 极空间 `/v2/file/list` 接口返回的 `is_dir` 字段为字符串 `"0"` / `"1"`，原前端 `Boolean("0")` 恒为 `true` 导致普通文件也被渲染为目录且隐藏了下载按钮；现已严格按 `"1"`/`1`/`true` 解析并优先适配 `modify_time`，按「目录在前、文件在后」清晰展示目录图标与文件下载按钮，移除令人困惑的「子目录已锁定」标签。
- **修复设置弹窗出现滚动条且界面高度抖动的问题**：
  - 将设置弹窗重构为紧凑双栏卡片布局（`max-w-2xl` + 固定头部/底部状态栏 + `scrollbar-gutter: stable`），正常窗体尺寸下完整平铺无滚动条，切换标签或点击保存/检查更新不再引起窗体跳动。

## [0.4.1] - 2026-11-26

### Added
- **支持真正的应用内更新（下载 → SHA-256 校验 → 自动安装重启）**：
  - 发现新版本时，主窗口右下角与「设置 → 版本与诊断日志」均可直接点击 **「立即应用内更新」**；由 Rust 后端（`updater.rs`）流式下载对应平台安装包、实时推送下载进度条与百分比，并在运行前强制校验 GitHub Release 提供的 `SHA-256` 摘要。
  - 校验通过后自动关闭当前进程并启动安装器完成覆盖更新与重启（Windows 自动适配 per-user `-setup.exe` 静默升级或 `Program Files` `.msi`；macOS 自动替换 `.app` 包或挂载 `.dmg`）。

### Changed
- **文件快传箱严格锁定至 `我的文件/downloads`**：
  - 打开后自动探测个人空间（`personal_spaces`）下已有的 `我的文件/downloads` 目录（不存在时自动在主空间创建），移除盘符选择器、面包屑跳转、目录切换与新建文件夹功能，确保快传文件集中收发不走偏。

## [0.4.0] - 2026-11-26

### Fixed
- **修复极空间 NAS 状态看板在 Z4 / ZOS V1 等机型上硬件卡片显示 `-` 的问题**：
  - 实机报文将设备硬件信息封装在 `system.detail.list[0]` 下，原解析未穿透 `detail` 与 `list` 数组，且 `cpu.used`（`0~1` 比例，如 `0.09` → `9.0%`）与 `cpu_fan`（兼容跳过 `-1` 传感器占位数、缺省时优雅展示核心温度）未完整映射；现已全面兼容 `detail.list[0]`、`polling`、`polling2` 等多层结构。
- **修复「原始 JSON」与「容器日志」文本无法选中复制的问题**：
  - 放开 `pre`、`code` 与 `.select-text` 区域文本选择与右键菜单限制，并在「NAS 状态 → 原始数据」和「Docker → 容器日志」中新增一键「复制 JSON / 复制日志」按钮。

### Added
- **窗口位置/大小与贴边停靠记忆持久化**：主窗口、悬浮待办窗（含贴边方位与显示状态）及独立桌面便利贴窗的位置/尺寸自动存入本地 SQLite，重启后自动校验显示器边界安全恢复。
- **托盘菜单与动态气泡增强**：系统托盘右键新增「立即同步」与各模块直达入口（待办/月视图/便签/快传箱/NAS 状态/Docker），托盘悬停 Tooltip 动态展示当前待办与逾期统计。
- **脱敏滚动诊断日志**：自动将运行日志按 `2 MiB` 滚动落盘至应用数据目录 `logs/zspace-kit.log`（写入前自动脱敏 token/cookie/code/密码），并在「设置 → 版本与诊断日志」提供一键「打开日志目录」。
- **版本更新检测**：后台静默对比 GitHub Releases 最新版本，左侧设置图标显示轻量更新提醒徽标，支持在设置中手动检查并一键直达下载页。

## [0.3.6] - 2026-11-25

### Fixed
- **修复 Windows 10/11 原生系统通知与测试通知不弹出的问题**：
  - `tauri-plugin-notification` 默认使用 `com.garyhj.zspacememo` 作为 Toast `AppUserModelID`，在未注册对应 `HKCU\SOFTWARE\Classes\AppUserModelId\com.garyhj.zspacememo`（或 `.msi`/快捷方式未带 AUMID）时会调用失败且内部静默吞错。
  - 启动及通知发送前自动注册当前用户的 Windows `AppUserModelId`（含 `ZSpace Kit` 名称与本地图标），绑定当前进程 AUMID，并直接使用 `tauri_winrt_notification` 同步弹出且透传真实错误信息（失败时自动回退保障可达）。

## [0.3.5] - 2026-11-25

### Fixed
- **修复悬浮待办窗首次贴边展开后失焦/移开未折叠的竞态 Bug**：首次由书签冷展开为大窗体时，Windows WebView2 会延迟派发 `WM_MOVE` 事件，此前会在 `350ms` 后误触发 `broke_peek` 清空贴边状态并终止鼠标监测循环。现记录预期展开坐标 `peek_pos`（仅真实拖动位移超过 `24px` 才解除贴边），并在窗体失焦且鼠标位于窗外时立即触发折叠，彻底解决“第一次打开失焦不关、多试几次才正常”的问题。

## [0.3.4] - 2026-11-25

### Changed
- **悬浮待办窗采用经典 QQ 式纯贴边交互（方案 A）**：消除书签“悬停 vs 点击”手势冲突，鼠标指向书签即顺滑贴边展开、移开自动折叠；如需脱离贴边常驻保留，直接按住顶栏拖出屏幕边缘或点击展开后顶栏的「移开固定」按钮即可，并缩短展开后拖拽响应保护期至 `350ms`。

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
