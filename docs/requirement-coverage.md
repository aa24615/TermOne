# TermOne 需求 - 测试覆盖矩阵（P0–P5）

> 本文件记录本期按 `docs/需求.md` 与 `docs/竞品分析与需求规划.md` 实现的功能，及其对应的测试覆盖。
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
| **P1** | Must 体验闭环（最高优先级，v0.2） | R-02 分组、R-04 自动重连+保活、R-03 分屏、R-01 SFTP |
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
| 边界 / 回归（P3–P5） | P3/P4/P5 | 损坏备份拒绝、空同步幂等、空关键字搜索、LWW 同戳不覆盖（RK-04） | `boundary_corrupt_backup_rejected`、`boundary_empty_sync_is_noop`、`boundary_search_empty_keyword_returns_all`、`boundary_lww_tie_not_applied` |

## 本期货未覆盖（需前端 / Tauri / 网络，非 term-core 单测范围）

| 需求 | 级别 | 未做原因 | 建议下一步 |
|---|---|---|---|
| R-01 SFTP 图形化文件管理 | P1 | 需系统 `sftp` 子系统或轻量库 + xterm 侧栏面板，非纯逻辑 | 技术选型验证（系统 sftp vs 轻量实现），再补面板与传输状态机 |
| R-03 分屏 Split Panes | P1 | 需 xterm 多实例 + 布局管理，属前端/壳层 | 在 `apps/desktop` 增加 Pane 模型与布局持久化，附 e2e |
| R-05 同步端到端加密 E2EE | P2 | 需加解密依赖 + 服务端零知识改造 | 引入 AEAD 依赖，密钥派生，密文仅服务端存储 |
| R-06 / R-10 端口转发 / JumpHost UI | P2 | 依赖系统 ssh `-L/-R/-J`，需 UI 与配置 | 复用 `session/ssh.rs` 参数，补 UI 与同步字段 |
| R-08 会话日志 | P2 | 需在会话层落盘与回放，偏前端/IO | 增加日志写入模块与回放视图 |
| R-11…R-17 主题市场/AI/Quake/广播/Zmodem/Linux/自动化 | Could/Won't | 增值层，超出本期 MVP | 轻量定位站稳后再排期 |
| R-18 移动端 / R-19 重型 IDE | Won't | 超出 Tauri 桌面范畴 | 不做 |

## 已知约束与风险

- **RK-07（无限重连刷屏）**：已由 `ReconnectPolicy.max_attempts` + `next_delay` 返回 `None` 显式停止覆盖；测试 `p2_max_attempts_stops_reconnect` 守护。
- **RK-04（并发同名冲突丢数据）**：LWW 采用「远端 updated_at 严格大于才覆盖」，相等时间戳不覆盖本地（测试 `boundary_lww_tie_not_applied`）；后续如需双副本可加版本号字段。
- **数据迁移**：`open_at` 对存量库执行 `ALTER TABLE` 补齐 `group_id` / `last_used_at`，新库经 `CREATE TABLE IF NOT EXISTS` 自带新列。
- **反序列化兼容**：新增 `group_id` / `last_used_at` 标记 `#[serde(default)]`，旧前端未下发这些字段时仍可正常反序列化。

## 测试汇总

- 总用例：28（storage 20 + reconnect 8）
- 结果：`28 passed; 0 failed`
- 命令：`cargo test -p term-core --target x86_64-pc-windows-gnu`（本机）/ `cargo test -p term-core`（常规）
