# 极空间原生记事本与 CLI 兼容性验证记录（M0 & v0.3.x）

> 验证日期：2026-11-24
> 验证环境：真实极空间 NAS（`Z041…QYG7`）+ 官方 `zspace-nas-agent-toolkit` v0.3.11（`zspace-cli`，OAuth2 授权）+ Windows 极空间官方桌面客户端。
> 验证范围：独立记事本 `location="2"`，全程在临时测试分类 `ZSpace Memo M0 Test`（ID `6`）中执行，测试完成后已清理无残留。

---

## 1. 总结与结论

**M0 验收通过。** 官方 `zspace-cli` + Windows 官方记事本客户端双向读写完全互通，所有三种候选格式在官方客户端编辑备注并保存后均 **100% 完整保留，无字节损坏**。

最终选定的存储格式：**候选 B（`<p>ZSM1:{...}</p>`）**（用户确认在官方客户端中显示最自然，且解析器同时兼容 `<pre>ZSM1:` 和 `<p>ZSM1b:`）。云便签模块沿用相同原理，采用 `<p>ZSK1:{...}</p>`。

---

## 2. M0 验证矩阵结果

| # | 验证项 | 结果 | 实测细节 |
|---|---|---|---|
| OAuth | 官方 `zspace-cli login --no-open --auth-code-stdin` | ✅ 通过 | 浏览器授权 + 一次性码，无需账号密码；凭证自动保存在受限目录 |
| 分类 | `all_classes` / `class_create` / `class_delete` | ✅ 通过 | `class_create` 返回标量分类 ID（如 `6`）；`all_classes` 返回扁平/树状列表 |
| T1 | CLI 新建 → Windows 官方客户端打开查看 | ✅ 通过 | 标题、中文摘要、分隔线、备注、数据块全部正常渲染；候选 B（`<p>` JSON）视觉最自然 |
| T2 | Windows 官方客户端修改备注并保存 → CLI `info` 读回 | ✅ 通过 | 候选 A（`<pre>` JSON）、B（`<p>` JSON）、C（`<p>` base64）的 `ZSM1` 数据块**全部逐字节保留**，JSON 解析 100% 成功；备注中的新增文字完整读回 |
| T2 细节 | 官方客户端对 HTML 的改写行为 | ⚠️ 需适配 | Windows 客户端会将部分四字节 Emoji 转为数字实体（例如 `📅` → `&#128197;`，`🔁` → `&#128257;`），但 ASCII/中文/JSON 引号完全不动。**对策：计算摘要哈希 `sum` 和解析正文前必须先做 HTML 实体反转义（unescape）** |
| `in_brief` | 官方列表摘要字段 | ✅ 确认 | Windows 客户端保存后自动将 `<h1>` 后的第一段设为 `in_brief`（实测为 `'📅 截止 2026-11-26 周四 18:00 '`），证明摘要行紧跟 `<h1>` 是正确设计 |
| T7 | 大正文（200 条重复历史，15,588 字符） | ✅ 通过 | `sent_len=15588, got_len=15588, exact_match=True`，无截断 |
| T8 | `list` 返回字段与增量同步依据 | ✅ 确认 | `list` **不返回 `body`**，返回 `['classify_id', 'classify_name', 'created_at', 'id', 'in_brief', 'label', 'length', 'note_type', 'pin_flag', 'title', 'updated_at']`。`updated_at` 为真实 Unix 秒时间戳，每次编辑都会更新，可直接用于增量同步 |
| `created_at` | 原生创建时间字段 | ⚠️ 需适配 | 新建与编辑后 `list` 和 `info` 返回的 `created_at` 均为 `0`。**对策：在 `ZSM1` 元数据中额外保存 `created_at`（ISO 8601）** |
| T9 | `history` 历史版本 | ⚠️ 需注意 | 新建后短时间内通过 CLI `update` 或 Windows 客户端编辑，`history` 返回空列表（推测极空间按时间间隔生成快照）。**对策：元数据丢失恢复以本地 SQLite `last_valid_meta` 为第一优先级，`history_info` 作为辅助回退** |
| T10 | `pin` / `search` / `delete` | ✅ 通过 | `pin`（`cancel: 0/1`）、按分类 `search`、`delete` 均正常返回 `ok: true` |

---

## 3. 对设计的具体修订

以下实测发现已同步回 [DESIGN.md](DESIGN.md)：

1. 待办数据块默认写入格式定为 `<p>ZSM1:{...}</p>`（解析器兼容 `<pre>ZSM1:` 和 `<p>ZSM1b:`），便签数据块使用 `<p>ZSK1:{...}</p>`。
2. 解析器和摘要哈希计算前统一做 HTML 实体反转义（处理 `&#128197;` 等 Emoji 实体）。
3. `ZSM1` / `ZSK1` 元数据均记录 `created_at` 字段，弥补原生接口返回 `created_at=0` 的问题。
4. 同步策略利用 `list` 返回的 `(id, updated_at, length)` 做增量拉取，只对变更笔记调用 `info`。

---

## 4. v0.2 ~ v0.3.1 开发期 CLI 与桌面端实战适配补充

在后续集成 OAuth2、Toolbox 工具箱与 Windows / macOS 桌面集成过程中确认了以下平台边界与工程对策：

1. **OAuth2 子进程管道与 Windows 控制台隐藏（`v0.2.2`）**
   - Windows 下拉起 `zspace-cli` 子进程必须设置 `CREATE_NO_WINDOW` 避免黑框闪烁；
   - `login --no-open --auth-code-stdin` 在输入授权码阶段需保持子进程 `stdout` 管道开启直到认证 JSON 返回。
2. **`zspace-cli` v0.3.11 全局参数位置与 `--yes` 确认（`v0.3.1`）**
   - `--profile <name>` 与 `--local-root <dir>` 属于全局选项，**必须放在子命令之前**（例如 `zspace-cli --local-root /dir file upload ...`）；否则文件上传/下载会报参数错误或读写受限目录外路径失败。
   - 所有状态变更命令（`file upload` / `file download` / `file mkdir`、`system events mark_read` / `mark_all_read`、`docker containers start` / `stop` / `restart`）必须显式携带 `--yes`，且部分业务错误会输出到 `stderr` JSON，需同时解析 `stdout` 与 `stderr`。
3. **Tauri 2 桌面权限与平台细节（`v0.2.8` / `v0.3.0` / `v0.3.1`）**
   - 无边框悬浮窗拖拽需在 `src-tauri/capabilities/default.json` 中显式授权 `core:window:allow-start-dragging`，并允许动态便签窗口通配符 `sticky-*`。
   - Windows WebView2 下 HTML5 `onDrop` 事件无法读取本地文件真实路径，快传箱必须使用 Tauri 原生 `getCurrentWebview().onDragDropEvent(...)` 获取系统拖入文件路径。
   - Windows 任务栏除打包图标外，需在应用 `setup()` 中显式对运行窗体调用 `win.set_icon(...)`（若此前固定过旧版本快捷方式，需取消固定再重固定以清理 Windows Shell 图标缓存）。
