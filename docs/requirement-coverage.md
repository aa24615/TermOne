# TermOne 需求 - 测试覆盖矩阵（P0–P5）

> 本文件记录本期按 `docs/需求.md` 与 `docs/竞品分析与需求规划.md` 实现的功能，及其对应的测试覆盖。
>
> **2026-10-23 战略修订**：主窗口主打「轻量实用」，SFTP、AI 辅助等增值能力**全部改为插件按需安装**。
> 新增 **R-20 插件运行时 + 插件管理（Must，前置）**，规格见 [`docs/插件系统设计.md`](./插件系统设计.md)，
> 改造清单见本文「插件化改造」章节。已实现的 SFTP 后端 IPC 命令保留在核心，UI 迁移为官方插件 `com.termone.sftp`。
> 测试执行层为 `crates/term-core`（README 明确的可单测核心库：存储 / LWW 同步 / 备份）。
> 运行命令：
> - 常规环境：`cargo test -p term-core`
> - 本机（MSVC `link.exe` 被 Git Bash 的 MinGW `link` 抢占且缺 Windows SDK）：`cargo test -p term-core --target x86_64-pc-windows-gnu`
>   （需预置 `RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu` 且 PATH 含 MinGW bin）

## 优先级映射说明

需求文档使用 MoSCoW（Must/Should/Could/Won't）与编号 R-01…R-19。本任务要求的「P0–P5 级别」按以下口径映射：

| 级别 | 含义 | 对应需求 |
|---|---|---|
| **P0** | 内核正确性 / 数据一致性（最不能错） | 既有 LWW 合并、软删除传播、备份完整性；及其在 R-02/R-07 中的复用 |
| **P1** | Must 体验闭环（最高优先级，v0.2） | **R-20 插件运行时（前置）**、R-02 分组、R-04 自动重连+保活、R-03 分屏、**R-01 SFTP（以插件形态交付）** |
| **P2** | Should 差异化加固（v0.3） | R-07 Snippets、R-09 最近会话、R-05 E2EE、R-08 日志、R-06/R-10 转发与跳板 |
| **P3** | 上述功能的边界与并发 | 分组嵌套删除、并发同名冲突、同步幂等 |
| **P4** | 健壮性（低优先） | Unicode、大体积负载、损坏输入、空同步 |
| **P5** | 风险登记（RK）对应场景 | RK-04 并发同名冲突双副本/版本号、RK-07 重连无限刷屏守卫 |

## 本期完成（term-core，已单测验证）

| 需求 | 级别 | 实现要点 | 测试（cargo test -p term-core, 28 passed） |
|---|---|---|---|
| 核心 LWW / 软删除 / 备份 | P0 | `storage.rs` 既有逻辑，被 R-02/R-07 复用 | `lww_merge`、`profile_roundtrip`、`settings_roundtrip`、`backup_roundtrip` |
| **R-02 连接分组/会话树** | P1 | `groups` 表；`profiles.group_id`；`group_create/rename/set_collapsed/delete`；`profile_search` 跨分组检索；分组纳入 LWW 同步与备份 | `group_crud_and_persistence`、`group_nesting_and_delete_reparents`、`profile_grouping_and_search_cross_group`、`group_sync_lww_and_backup`、`group_unicode_name` |
| **R-04 SSH 自动重连 + 心跳保活** | P1 | `reconnect.rs`：`ReconnectPolicy`（指数退避+最大重试+抖动）、`KeepAlivePolicy`（空闲心跳）；纯逻辑零 I/O | `p0_first_delay_is_base`、`p1_exponential_growth_capped`、`p2_max_attempts_stops_reconnect`、`p3_factor_one_is_constant`、`p4_jitter_bounds`、`p5_edge_no_overflow_zero_base`、`keepalive_idle_triggers`、`keepalive_zero_interval_always` |
| **R-07 常用命令 Snippets 片段库** | P2 | `snippets` 表；`snippet_save/list/delete`；纳入 LWW 同步与备份 | `snippet_crud_and_dirty`、`snippet_export_mark_pushed`、`snippet_sync_lww`、`snippet_backup_roundtrip_and_unicode` |
| **R-09 最近会话/连接历史** | P2 | `profiles.last_used_at`；`profile_touch`、`profile_list_recent(limit)`；touch 不触发云同步 | `profile_recent_tracks_last_used`、`profile_recent_ordering_and_limit`、`profile_touch_does_not_set_dirty` |
| **R-03 分屏 Split Panes** | P1 | `paneTree.ts` 面板树模型；`Tab` 承载 `layout` 树；水平/垂直分屏 + 拖拽分隔条；快捷键 Alt+Shift+H/V 分屏、Alt+Shift+X 关面板；`TerminalView` 改为按 `Pane` 渲染 | 前端 tsc + vite 构建通过；交互待真机验证 |
| **R-08 会话日志 Session Logging** | P2 | `session_open` 按 `logSessions` 设置把输出字节 tee 到 `<app_data>/logs/<uuid>.log`；新增 `session_log_read` 回放命令；设置开关 + 面板「日志」回放弹窗（ANSI 清理） | 前端 tsc 通过；后端待本机构建验证 |
| **R-06/R-10 端口转发/JumpHost** | P2 | `SessionRequest` 增 `proxyJump/localForward/remoteForward/dynamicForward`；`ssh.rs` 组装 `-J/-L/-R/-D`；`ProfileDialog` SSH 区新增字段 | 前端 tsc 通过；后端待本机构建验证 |
| **R-05 同步端到端加密 E2EE** | P2 | 前端 Web Crypto（PBKDF2 + AES-GCM）加密同步 `data`，服务端零知识（仅存密文）；口令仅内存不落盘；设置开关 + 重新解锁 | 前端 tsc 通过；单元自测待补 |
| **R-01 SFTP 图形化文件管理** ⚠️待插件化 | P1 | 复用系统 `sftp -b -` 批处理（**零新增 Rust 依赖**，与 `ssh.rs`「复用系统 ssh」一致）；`session/sftp.rs`：连接参数构造 + 批处理 + `ls -la` 解析；`list/mkdir/remove/rename/download/upload`；`commands.rs` 暴露 6 个 SFTP 命令 + `local_list/local_mkdir`；前端 `FileManager` 侧栏（远端/本地双栏、面包屑、导航、删除/重命名/上传/下载、传输队列），`@tauri-apps/plugin-dialog` 选目录 | 前端 tsc + vite 通过；`sftp.rs` 含 3 个解析单测（随 `cargo test -p term-core` 运行）；端到端待本机构建 + 真机验证。**已按插件化战略改判：6 个 IPC 命令留核心，UI 迁移为官方插件 `com.termone.sftp`** |
| 边界 / 回归（P3–P5） | P3/P4/P5 | 损坏备份拒绝、空同步幂等、空关键字搜索、LWW 同戳不覆盖（RK-04） | `boundary_corrupt_backup_rejected`、`boundary_empty_sync_is_noop`、`boundary_search_empty_keyword_returns_all`、`boundary_lww_tie_not_applied` |

## 插件化改造（新战略，进行中）

> 依据：`docs/需求.md` §2/§3；规格：`docs/插件系统设计.md`；编号与排期：`docs/竞品分析与需求规划.md` §4.0。
> 目标：主窗口只保留「轻量实用」的核心，SFTP / AI 辅助 / 广播 / 日志回放 / 主题市场等增值能力**全部改为插件按需安装**。

### 决策

- **插件形态**：前端插件为主（JS/TS 包 + 动态 `import()` 懒加载 + 受限 Host API），零新增原生依赖，跨平台免编译。
- **边界**：**能力（涉密/高频 IPC 命令）留在核心，UI 与交互逻辑放进插件**。插件迭代**无需重编 Rust**——这对本机受限的构建环境尤为关键。

### 改造清单

| 功能 | 现状 | 目标形态 | 是否需重编 Rust |
|---|---|---|---|
| SFTP（`FileManager.tsx`） | 已实现，内置 | 官方插件 `com.termone.sftp` | **否**（6 个 IPC 命令已在核心） |
| 会话日志回放 | 已实现，内置弹窗 | 官方插件 `com.termone.session-log`（录制开关留核心） | 否 |
| Snippets UI | 后端已实现 | 官方插件 `com.termone.snippets` | 否 |
| 插件运行时（R-20） | 未实现 | 核心新增 `plugin/{types,hostApi,registry,loader,manager,sandbox}` + `plugins` 表 + 4 个 IPC 命令 | **是**（新增 IPC 命令） |
| AI 辅助 / 广播 / Quake / Triggers / 主题市场 / Zmodem | 未实现 | 全部为插件 | 否（若需新能力则另补命令） |

### 实施分期与验证口径

| 阶段 | 内容 | 可否本机验证 |
|---|---|---|
| S1 运行时地基 | 类型/Host API/注册表/加载器/沙箱/`plugins` 表/IPC 命令/管理对话框 | 前端可（`tsc` + `vite`）；IPC 命令需 CI 构建 |
| S2 样板插件 | `FileManager.tsx` → `com.termone.sftp` | **可**（纯前端） |
| S3 分发 | `.tpk` 打包导入、registry、更新、审计 UI | 前端可 |
| S4 增值插件 | AI → 广播 → 日志回放 → Triggers → Quake → 主题市场 → Zmodem | 可 |

### 插件化验收口径（对应插件系统设计 §9）

| # | 口径 |
|---|---|
| AC-1 | 零插件时冷启动/内存与无插件版差异 ≤ 5% |
| AC-2 | 主 bundle 不含插件代码，SFTP 落在独立 chunk |
| AC-3 | 插件崩溃被错误边界隔离，主窗口与会话不中断 |
| AC-4/5 | 越权 IPC 拒绝并记录审计；密钥环无接口可用 |
| AC-6/7 | 停用/卸载后贡献点与私有存储无残留 |
| AC-8/9 | 第三方插件需确认权限与风险；AI 插件未配 Key 时不发起网络请求 |

## 本期货未覆盖（需前端 / Tauri / 网络，非 term-core 单测范围）

> R-01 / R-03 / R-05 / R-06 / R-08 / R-10 已实现并移入上方「本期完成」表；其中 SFTP、分屏、转发、日志等交互层需在本机（或 CI）完成 Rust 构建后做端到端验证。

| 需求 | 级别 | 未做原因 | 建议下一步 |
|---|---|---|---|
| **R-20 插件运行时 + 插件管理** | **Must** | 新战略的地基，尚未实现 | **最高优先**：先做 S1 运行时，再做 S2（SFTP 插件化）；S1/S2 以纯前端为主，本机可验证 |
| R-11 主题市场（插件） | Could | 需 registry 与分发链路 | 待 R-20 完成后以插件形态交付 |
| R-12 AI 命令辅助（插件） | Could | 需外部 API、隐私与轻量权衡 | 以默认关闭插件交付，域名白名单 + 用户自填 Key |
| R-13 Quake / R-14 广播 / R-17 Triggers（插件） | Could | 增值层 | R-20 完成后批量插件化 |
| R-15 Zmodem / Sixel（插件） | Could | 低优先、工程量中等 | 插件形态后置 |
| R-16 Linux 支持 | Could | 扩平台，维护面增加 | 轻量定位站稳后再排期 |
| R-18 移动端 / R-19 重型 IDE | Won't | 超出 Tauri 桌面范畴 / 与轻量红线冲突 | 不做 |

## 已知约束与风险

- **RK-07（无限重连刷屏）**：已由 `ReconnectPolicy.max_attempts` + `next_delay` 返回 `None` 显式停止覆盖；测试 `p2_max_attempts_stops_reconnect` 守护。
- **RK-04（并发同名冲突丢数据）**：LWW 采用「远端 updated_at 严格大于才覆盖」，相等时间戳不覆盖本地（测试 `boundary_lww_tie_not_applied`）；后续如需双副本可加版本号字段。
- **数据迁移**：`open_at` 对存量库执行 `ALTER TABLE` 补齐 `group_id` / `last_used_at`，新库经 `CREATE TABLE IF NOT EXISTS` 自带新列。
- **反序列化兼容**：新增 `group_id` / `last_used_at` 标记 `#[serde(default)]`，旧前端未下发这些字段时仍可正常反序列化。
- **本机 Rust 构建受限（RK-08，环境约束非代码问题）**：根因是开发机 **Windows 智能应用控制（Smart App Control）处于强制模式**（`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState = 1`），拦截 cargo 临时编译出的**未签名 build-script exe**（`target/**/build-script-build.exe`），报 `os error 4551`（应用程序控制策略已阻止此文件）。硬证据：构建日志中成功执行的 build-script 数为 **0**；手动执行 build-script-build.exe 为 Permission denied。因此 R-08/R-06/R-10/R-01 的 Rust 侧改动**仅经代码走查 + 前端 tsc/vite 验证**，尚未在本机编译/跑测。需在不受管控的机器（或 CI）执行 `cargo test -p term-core --target x86_64-pc-windows-gnu` 与 `npm run tauri build` 做端到端验证后再发版。
  - **重要教训**：build-script 的**输出只要还在缓存里，cargo 就不会执行它**。因此「某 crate 能编译成功」不等于「策略放行了该 crate」。本机执行 `cargo clean` / `rm -rf target/release` **前必须先确认 build-script 输出是否有备份**，否则所有 build-script 将被迫重跑并全部被拦，本地打包彻底失效（本次已踩坑）。
  - **缓解**：插件化战略本身即为结构性缓解——插件为纯前端，S1/S2/S3 迭代无需重编 Rust，本机可用 `tsc` + `vite` 完整验证。
- **插件化风险（详见 `docs/竞品分析与需求规划.md` 风险登记册）**：RK-09 插件权限滥用（最小权限 + manifest 声明 + IPC/域名白名单 + 密钥环硬编码拒绝 + 审计日志）；RK-10 插件膨胀反噬轻量（默认不启用 + 懒加载 + 独立 chunk + 零插件开销预算 ≤ 5%）；RK-11 插件崩溃传染（错误边界 + activate 超时 + deactivate 强制回收）。

## 测试汇总

- 总用例：28（storage 20 + reconnect 8）
- 结果：`28 passed; 0 failed`
- 命令：`cargo test -p term-core --target x86_64-pc-windows-gnu`（本机）/ `cargo test -p term-core`（常规）
