# Changelog

All notable changes to **ZSpace Kit（极空工具箱）** (repository `ZSpaceMemo`) are documented in this file.

## [0.8.3] - 2026-11-27

### Fixed
- **Windows 系统提醒与应用内兜底**：规范 Windows 通知注册表 `IconUri` 为 `file:///` URI 格式，并在提醒触发与「测试提醒」时同步派发 `reminder:fired` 事件，在应用内弹出顶部提醒条并播放提示音兜底。

## [0.8.2] - 2026-11-27

### Added & Fixed
- **跨更新凭据持久化（`R2-AUTH`）**：新增 `credential_store` 设置项并在调用 `zspace-cli` 时透传 `--credential-store <file|auto|keyring>`，默认使用 `file`（本地应用数据目录），避免 Windows / macOS 覆盖更新后因系统钥匙串身份变化导致频繁重新扫码授权；设置页「极空间连接」同步开放策略切换。

## [0.8.1] - 2026-11-27

### Added
- **Kubai 分层动态图标体系**：参照 `kubai087/kubai-icons` 规范绘制 8 枚功能动态图标（`待办`、`月视图`、`便签`、`快传箱`、`NAS状态`、`Docker`、`下载器`、`设置`），支持外描边遮罩、投影与顶部内发光及 460ms `cubic-bezier(0.22, 1, 0.36, 1)` 悬停动画，并集成至左侧导航栏 `ToolRail`（附 `kubai-icons/` 展示页与自检工作区）。

## [0.8.0] - 2026-11-27

### Added
- **标签批量管理与任务多选操作（`D5-1`）**：
  - 左侧标签区支持行内重命名、同名合并及确认后全局移除；
  - 任务列表新增「多选」模式与底部悬浮操作栏，支持全选、批量迁移清单、批量打标与批量完成。
- **Docker 镜像与 Compose 看板扩展（`D5-2`）**：
  - Docker 看板新增「镜像」与「Compose」标签页（支持搜索、镜像体积展示与项目状态浏览）。
- **NAS SMART 健康与备份状态只读巡检（`D5-3`）**：
  - NAS 状态页并发拉取 `storage smart` 与 `backup status`（不支持时优雅降级），新增磁盘 SMART 健康告警卡与备份同步任务状态卡。
- **任务备注安全 Markdown 预览（`D7-1`）**：
  - 详情页备注预览新增零依赖 XSS 安全 Markdown 渲染切换（标题、粗斜体、行内/围栏代码块、清单及安全 HTTP/HTTPS 链接点击打开），保持与 `ZSM1` 原文双向兼容。

### Changed & Fixed
- **Tauri 宿主机入口模块化（`C5-Tauri`）**：将 `src-tauri/src/lib.rs` 中的状态与窗口停靠几何逻辑拆出至 `state.rs` 与 `window_dock.rs`。
- **交互与上传校验修复**：
  - 修复 `TimePicker` 在 Windows WebView2 / macOS WKWebView 下因 `onFocus` 早于 `pointerup` 触发原生 `popover="auto"` light-dismiss 导致一闪而过或再次点击无法弹出的问题；
  - 上传任务附件前预校验极空间 16 MB（16,777,216 字节）官方上限并引导大文件改用「文件快传」。

## [0.7.2] - 2026-11-26

### Fixed & Hardened
- **P0 核心可靠性与安全性加固（`A1`–`A7`）**：
  - **元数据编解码与兼容保留（`A1`）**：`ZSM1` 任务元数据写入统一 HTML 转义，限定解析末尾 `<hr>` 区段，支持 `Task.meta_extra` 保留未来未知字段，并共享 HTML/Regex 工具至便签解析。
  - **同步互斥与并发竞态消除（`A2`）**：`TaskService` / `StickyService` 新增同步互斥锁、按条目异步锁与同步期间新建/删除防误删追踪；写操作统一拉取最新远端并校验 ETag，恢复失败不再污染远端基线。
  - **提醒可靠性与 SQLite/调度加固（`A3`）**：事务化 `TEMP TABLE` 裁剪并取消已删任务的挂起提醒；CLI 不存在错误映射 `TaskNotFound`；启动回收超时 `firing` 作业并清理 60 天旧记录；调度器拆离同步以免阻塞提醒并按真实挂钟时间差支持休眠唤醒重同步；全量替换 `lock_conn()` 与启用 `busy_timeout`。
  - **前端陈旧闭包与乱序保护（`A4`）**：`MainWindow` 改用 `filtersRef` 与请求序号保护，`tasks:synced` 等事件不再将筛选/搜索视图退回“今天”。
  - **应用内更新安全与原子安装（`A5`）**：Rust 后端按当前系统+架构从官方 Release API 独立核验资产与 64 位 SHA-256（缺 digest 拒绝自动安装）；收窄允许 URL 与跳转；macOS 改 `.bak` 备份回滚与 PID 等待、`.dmg` 改手动；下载用 `.part`、启动清旧包，并在前端锁定安装期间关闭与展示进度/错误。
  - **进程退出与自启动双向对齐（`A6`）**：取消托盘关闭主窗时调用 `app.exit(0)`；支持 macOS Dock `Reopen`；启动及保存设置双向同步 `autolaunch` 且暴露失败提示；Windows AUMID 注册改为每进程一次。
  - **快传箱分页与路径/SSRF 加固（`A7`）**：`upload_paths` 分页拉取目录全量子项并透传错误；`upload_file` 禁传软链并修复单文件名相对路径；严格校验下载 URI 拦截控制字符与环回/内网地址；CLI 增加 `kill_on_drop + timeout`、安全字符截断与失败回滚 `pending_clear_host`。
- **草稿保护、并发队列与清单持久化（`B3`）**：
  - 自定义清单按 NAS 账户持久化至 `localStorage` 并纳入已完成任务清单；登出完整清理内存状态且保留已存清单；修复添加清单失焦残留草稿。
  - `TaskDetail`、`StickyBoard`、`StickyFloatingCard` 增加 600–800ms 防抖保存、脏草稿防同步覆写保护与切换/卸载/关窗前 flush；`TaskDetail` 与 `SettingsModal` 均改串行队列并追踪最新 ETag/配置。
- **前端包体积瘦身与事件监听优化（`C1`）**：
  - `React.lazy` 懒加载 9 大窗口/模块与 3 个弹窗，配合 Vite `manualChunks` 将主入口 JS 拆包瘦身。
  - `usePrefs` 升级为 `useSyncExternalStore` 全局单监听器实现。
- **P1 体验稳定性、安全硬化与需求收口（`B1`–`B5` / `C2`–`C5` / `D1`–`D3`）**：
  - **秒开离线缓存 & 调度避让（`B1`）**：启动先读本地 SQLite 缓存秒开主界面，云端同步改后台异步并发执行，并增加 20 秒同步避让窗口防止前后台同时全量同步。
  - **重复任务顺延与单期改期统合（`B2`）**：后端计算多时区 DST `is_overdue` 与 `effective_current_key`；修复手动/有限次已结束系列重新打开恢复；一键顺延与详情/右键/悬浮窗统一走 `overrideOccurrence`。
  - **子模块稳健性与错误可读化（`B4`–`B5`）**：统一解析后端 `ErrorPayload` 与鉴权失效重登引导；月视图防重提与全操作失败回滚；快传箱抽离全局 `transferStore` 与重名去重；下载器递归定时防叠罗汉；收窄全局快捷键至 `tasks` 工作区与无弹窗/无输入框上下文。
  - **CSP 启用、最小 Capability 与日志安全（`C2`–`C4`）**：配置严格 Tauri 2 CSP、按主窗/浮窗最小权限拆分 `capabilities`、移除未使用通知插件；`SanitizedTeeWriter` 统一脱敏 `stderr`；补齐前后端核心自动化单元测试与 CI `fmt` / `clippy` / `--frozen-lockfile` 门禁。
  - **大文件模块化拆解（`C5`）**：将 `SettingsModal`、`TaskDetail`、`App` 工具栏/侧边栏/筛选逻辑与核心库 `crates/core/src/service` 拆分为职责清晰的子模块并补全纯逻辑单测。
  - **重复截至日期、附件语义与快捷键自定义（`D1`–`D3`）**：`RepeatModal` 补全 `until` 截至日期选择器；移除附件/删含附件任务弹窗明确不物理删 NAS 文件边界；设置页新增全局呼出热键录制器、常用预设与系统级冲突回滚。
- **Modern Web 架构现代化迁移（`macOS 14.0+` / `WebView2` 基线）**：
  - 移除 ~308 kB 第三方 `lunar-javascript`，替换为零依赖离线查表引擎（1901–2099 年农历与节气全量 0 误差校验）；构建目标收敛为 `["chrome114", "safari17.0"]` 与 macOS `minimumSystemVersion: "14.0"`。
  - 全量模态框与 9 处阻塞式 `window.confirm()` 迁移至原生 HTML `<dialog>.showModal()` 与 `ConfirmDialogHost`。
  - 5 处下拉菜单、右键菜单、月视图溢出/快编浮层迁移至原生 Popover API（`popover="auto"`），移除手写全局外部点击及 Escape 监听；列表已完成折叠改用 `<details>`/`<summary>`，任务勾选改用 `onAnimationEnd` + `prefers-reduced-motion`，补齐 `structuredClone`、`crypto.randomUUID`、`overscroll-contain` 与共享 `groupByKey`/`formatBytes`。

## [0.7.1] - 2026-11-26

### Changed & Polished
- **滴答清单风格左侧边栏重构**：
  - 顶部核心智能视图聚焦为 `所有`、`今天`、`最近 N 天`、`收集箱` 4 项，配合动态日期角标图标与柔和的 `#eef3ff` 选中胶囊高亮
  - `清单` 与 `标签` 分区支持折叠/展开状态持久化（`UiPrefs`），清单颜色圆点移至右侧计数旁，左右对齐更清爽
  - `已逾期`、`重复任务`、`已完成` 归拢至侧边栏底部工具区
  - 任务列表标题旁新增左侧边栏一键收起/展开开关；`今天` 视图中的 `已过期` 分组头新增一键「顺延」按钮（自动将普通与重复逾期任务批量顺延至今天）
  - 任务列表行间距、正文字色与日期列字号微调，整体对比度与阅读节奏更舒适

## [0.7.0] - 2026-11-26

### Added
- **待办原生附件（基于官方 `file notes` `attachment_upload` / `attachment_download`）**：
  - 数据模型 [`TaskAttachment`](crates/core/src/models.rs) 嵌入 `ZSM1` 元数据，并在笔记可读摘要行自动渲染 `📎 附件 N 个（...）`。
  - `TaskDetail` 新增「附件」区块，支持多文件选择上传（自动设置 `--local-root` 与 300s 超时）、本地另存为下载与关联移除；`TaskListItem` 同步展示曲别针附件数量角标。
- **NAS 下载器看板（`Alt + 7` / macOS `Option + 7`）**：
  - 工具箱新增第七个核心工作区 [DownloaderView](src/modules/downloader/DownloaderView.tsx)，聚合官方 `zspace-cli download control`（`tasks/details` / `downloaddir`）、`download tasks` 与 `download manage`。
  - 支持按「全部 / 进行中 / 已完成」切换、关键词检索、进度条与上下行速率展示、可选 5 秒自动刷新、单任务「继续 / 暂停 / 删除」、原始响应 JSON 复制，以及带 `--allow-nas-fetch` 安全提示与目录补全的新建下载表单（HTTP/HTTPS/Magnet/ed2k/FTP）。

### Changed
- **IPC 与文档同步**：新增 7 个 Tauri IPC 命令（总计 72 个：`upload_task_attachment` / `download_task_attachment` / `remove_task_attachment` / `nas_download_tasks` / `nas_download_dirs` / `nas_download_add` / `nas_download_action`），更新快捷键说明与设计文档至 `v0.7.0`。

## [0.6.0] - 2026-11-26

### Added
- **中国法定工作日与调休重复（`cn_workday`）**：在每日重复规则与 Rust 调度核心中内置 `2001–2027` 国务院法定节假日及调休补班表（`crates/core/src/lunar_tables.rs`、`crates/core/src/lunar.rs`），支持自动跳过法定假日、识别周末调休上班日，并在 2027 年之后自动回退至周一至周五。
- **离线中国农历重复（1901–2099）**：`RepeatRule` 新增 `calendar: "lunar"` 与 `lunar` 配置，支持「每月农历」「每年农历」及闰月策略（顺延至平月 `follow` / 闰月也触发 `both` / 仅闰月 `only_leap`）与无效日顺延或跳过；在重复编辑器 `RepeatModal` 中提供公历/农历切换、闰月策略选择与未来 5 次公历映射日期实时预览。
- **单次发生实例改期与恢复 UI**：`TaskDetail` 重复时间轴与 `MonthCalendarView` 快速卡片支持直接查看「已改期」标记、单独改期单次发生实例（含日期/时间修改）并一键恢复原系列排期（新增 `clear_occurrence_override` IPC 命令，总计 65 个命令）。

### Fixed & Improved
- **逾期收拢策略与时区修复**：修复单次改期延后至今天或未来时 `CatchUpPolicy::Latest` 错误推进系列游标的问题；`get_occurrence_timeline` 改用任务配置时区计算当天日期基准。
- **前端与文档同步**：更新 `RepeatRule`/`OccurrenceView` 类型定义、`describeRepeatZh` 中文描述、应用内版本基线与项目文档至 `v0.6.0`。

## [0.5.0] - 2026-11-26

### Added
- **极空间 LAN 内网直连模式与 CLI 连接诊断（`doctor`）**：
  - 在「设置 → 连接与更新」中支持切换连接策略：**自动 (`auto`)** / **云代理 (`cloud`)** / **LAN 内网直连 (`lan`)**，支持自定义固定 NAS 地址（如 `https://192.168.1.2:5056` 或 `http://192.168.1.2:5055`）、HTTP 安全勾选保护以及普通请求超时设置，并在切回云端或清空地址时自动通过 `--clear-host` 清除遗留内网地址绑定。
  - 新增「连接诊断 (`zspace-cli doctor`)」功能，展示实测延迟、有效连接模式/地址、健康详情与错误定位；启用 LAN 直连时 ToolRail 与快传箱同步显示直连指示徽标。
  - 文件上传与下载默认保障至少 `300s` 传输超时，避免大文件传输过早超时中断。
- **文件快传箱实用性升级（仍严格锁定 `我的文件/downloads`）**：
  - **支持文件夹递归上传**：直接拖拽文件夹或点击「上传文件夹」即可镜像创建子目录并递归上传全部文件（自动忽略 `.DS_Store` / `Thumbs.db` 等系统垃圾文件，已存在同名目录智能复用避免生成冗余副本），并实时推送单文件进度（`files:transfer-progress`）。
  - **统一上传/下载队列与失败重试**：上传与下载统一纳入顶部「传输队列」，任意单文件失败可一键点击「重试」单独续传。
  - **多选批量下载与列表分页**：支持勾选多个文件一键批量下载到本地指定文件夹，列表超过 100 项时支持「加载更多文件」。

### Changed
- **设置弹窗三标签重构（消除高度抖动与滚动条）**：
  - 将设置拆分为「常规」「连接与更新」「快捷键」三个固定高度（`420px`）标签页，彻底消除切换选项卡与状态消息时的页面抖动。

## [0.4.3] - 2026-11-26

### Fixed
- **彻底修复 Windows 应用内更新关闭软件后未覆盖安装与重启的问题**：
  - 此前通过隐藏 PowerShell 传入裸 `/S` 启动安装包时，Tauri NSIS 安装模板因缺少 `/UPDATE` 标记会误进入卸载检查流程并被静默中止，且异步退出可能与安装器抢占进程锁。
  - 现改为完全对齐官方 `tauri-plugin-updater` 方案：在下载与 SHA-256 校验通过后，直接调用 Win32 `ShellExecuteW` 启动 `-setup.exe` 并传入 **`/P /UPDATE /R`**（被动安装进度条 + 跳过卸载覆盖更新 + 自动拉起新版 `.exe`），同时适配 `.msi` 的 `/passive /promptrestart AUTOLAUNCHAPP=True` 参数并立即退出主进程。

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
