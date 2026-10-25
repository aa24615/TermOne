//! 命令历史检索：匹配、排序与按主机隔离。
//!
//! 纯逻辑、零 I/O、无额外依赖，便于单元测试，并可在命令面板（桌面端 / Web 端通用）复用。
//! 对应需求 **R-24（应用级命令面板 + 历史命令搜索）** 与 **R-38（按主机的命令历史隔离检索）**。
//!
//! 设计原则：
//! - **字面匹配**：查询按字面子串匹配（默认大小写不敏感），正则元字符（`.` `*` `(` 等）按字面处理，
//!   避免把 `a.b` 误当正则去匹配 `axb`，也避免特殊字符导致 panic（P4 防误报）。
//! - **主机隔离**：`host_filter = Some(id)` 只返回该主机命令 + 本地（host_id 为 None）命令，
//!   严格不把主机 A 的历史泄露到主机 B 的检索中（R-38 的「避免 A 命令误跑 B」语义）。
//! - **排序稳定可断言**：分数（精确/前缀/词边界/子串）→ 使用频次 → 最近使用 → 命令字典序，
//!   结果为确定序列，便于测试与 UI 稳定呈现。
//! - **聚合去重**：相同命令（大小写不敏感）在同一主机下合并为一条，累加使用次数、取最新时间戳。

use serde::Serialize;
use std::collections::BTreeMap;

/// 一条命令历史记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// 实际键入的命令（保留原始大小写，用于回填）
    pub command: String,
    /// 来源主机 id；本地终端为 None。用于按主机隔离检索（R-38）。
    #[serde(default)]
    pub host_id: Option<String>,
    /// 最近一次使用的时间戳（毫秒）
    pub timestamp: i64,
    /// 累计使用次数（同命令同主机聚合）
    pub use_count: u32,
}

/// 检索选项。
#[derive(Debug, Clone, Default)]
pub struct HistoryQuery {
    /// 主机隔离：`Some(id)` 限定到该主机（同时保留本地命令）；`None` 为全局检索。
    pub host_filter: Option<String>,
    /// 返回结果上限（0 表示不返回）。
    pub max_results: usize,
    /// 是否区分大小写，默认 false（不区分）。
    pub case_sensitive: bool,
}

/// 判断 `command` 是否匹配 `query`。
///
/// 空查询匹配一切（由排序逻辑呈现）；非空查询按字面子串匹配，大小写默认不敏感。
/// 正则元字符按字面处理，不会触发正则解释。
pub fn matches_query(query: &str, command: &str, case_sensitive: bool) -> bool {
    let q = if case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };
    let q = q.trim();
    if q.is_empty() {
        return true;
    }
    let c = if case_sensitive {
        command.to_string()
    } else {
        command.to_lowercase()
    };
    c.contains(&q)
}

/// 对匹配命中的命令计算排序分数。
///
/// - 完全相等：100
/// - 前缀匹配（首个词即以 query 开头，后接空白或结尾）：70
/// - 词边界匹配（任一空白分隔词以 query 开头）：50
/// - 其余子串匹配：30
/// `q` 与 `cmd` 均已小写并 trim。
fn match_score(q: &str, cmd: &str) -> i32 {
    if q.is_empty() {
        return 0;
    }
    if cmd == q {
        return 100;
    }
    if cmd.starts_with(q) {
        let after = &cmd[q.len()..];
        if after.is_empty() || after.chars().next().map(|c| c.is_whitespace()).unwrap_or(false) {
            return 70;
        }
    }
    for token in cmd.split_whitespace() {
        if token.starts_with(q) {
            return 50;
        }
    }
    30
}

/// 主机隔离判定：过滤后保留「全局」或「目标主机 + 本地命令」。
fn host_ok(entry_host: &Option<String>, filter: &Option<String>) -> bool {
    match filter {
        None => true,
        Some(f) => match entry_host {
            None => true,
            Some(h) => h == f,
        },
    }
}

/// 在命令历史中检索并排序。
///
/// 1. 按 `host_filter` 做主机隔离；
/// 2. 同命令（大小写不敏感）同主机聚合为一条；
/// 3. 移除不匹配项（空查询保留全部）；
/// 4. 按分数 → 使用次数 → 最近使用 → 命令字典序稳定排序；
/// 5. 截断到 `max_results`。
pub fn search_history(query: &str, entries: &[HistoryEntry], opts: &HistoryQuery) -> Vec<HistoryEntry> {
    // 1) 主机隔离
    let filtered: Vec<&HistoryEntry> = entries.iter().filter(|e| host_ok(&e.host_id, &opts.host_filter)).collect();

    // 2) 聚合去重。大小写不敏感模式下按小写聚合；区分大小写模式保留原大小写（"Git" 与 "git" 视为不同命令）。
    let mut merged: BTreeMap<(String, Option<String>), HistoryEntry> = BTreeMap::new();
    for e in filtered {
        let key_cmd = if opts.case_sensitive {
            e.command.clone()
        } else {
            e.command.to_lowercase()
        };
        let key = (key_cmd, e.host_id.clone());
        match merged.get_mut(&key) {
            Some(rep) => {
                let better = e.use_count > rep.use_count
                    || (e.use_count == rep.use_count && e.timestamp > rep.timestamp)
                    || (e.use_count == rep.use_count
                        && e.timestamp == rep.timestamp
                        && e.command < rep.command);
                if better {
                    rep.command = e.command.clone();
                    rep.host_id = e.host_id.clone();
                }
                rep.use_count += e.use_count;
                if e.timestamp > rep.timestamp {
                    rep.timestamp = e.timestamp;
                }
            }
            None => {
                merged.insert(key, e.clone());
            }
        }
    }

    // 3) 匹配 + 打分
    let q = if opts.case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };
    let q_trim = q.trim();
    let mut ranked: Vec<(HistoryEntry, i32)> = Vec::new();
    for (_, e) in &merged {
        let cmd = if opts.case_sensitive {
            e.command.clone()
        } else {
            e.command.to_lowercase()
        };
        if !q_trim.is_empty() && !cmd.contains(q_trim) {
            continue;
        }
        let score = if q_trim.is_empty() {
            0
        } else {
            match_score(q_trim, &cmd)
        };
        ranked.push((e.clone(), score));
    }

    // 4) 稳定排序
    ranked.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| b.0.use_count.cmp(&a.0.use_count))
            .then_with(|| b.0.timestamp.cmp(&a.0.timestamp))
            .then_with(|| a.0.command.cmp(&b.0.command))
    });

    // 5) 截断
    ranked.truncate(opts.max_results);
    ranked.into_iter().map(|(e, _)| e).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(command: &str, host_id: Option<&str>, timestamp: i64, use_count: u32) -> HistoryEntry {
        HistoryEntry {
            command: command.into(),
            host_id: host_id.map(String::from),
            timestamp,
            use_count,
        }
    }

    fn opts(host_filter: Option<&str>, max_results: usize) -> HistoryQuery {
        HistoryQuery {
            host_filter: host_filter.map(String::from),
            max_results,
            case_sensitive: false,
        }
    }

    // ---------- P0：正常路径 / 日常使用 ----------
    #[test]
    fn p0_substring_search_returns_matching_commands() {
        let data = vec![
            entry("git status", None, 3, 1),
            entry("git log --oneline", None, 2, 1),
            entry("ls -la", None, 1, 1),
        ];
        let r = search_history("git", &data, &opts(None, 10));
        assert_eq!(r.len(), 2);
        assert!(r.iter().all(|e| e.command.starts_with("git")));
    }

    #[test]
    fn p0_empty_query_returns_all_sorted_by_usage_then_recency() {
        let data = vec![
            entry("ls", None, 1, 1),
            entry("git status", None, 5, 9),
            entry("npm run dev", None, 3, 4),
        ];
        let r = search_history("", &data, &opts(None, 10));
        assert_eq!(r.len(), 3);
        // 使用次数最高优先
        assert_eq!(r[0].command, "git status");
        assert_eq!(r[1].command, "npm run dev");
        assert_eq!(r[2].command, "ls");
    }

    #[test]
    fn p0_exact_match_ranks_above_prefix() {
        let data = vec![entry("ls -la", None, 1, 1), entry("ls", None, 2, 5)];
        let r = search_history("ls", &data, &opts(None, 10));
        assert_eq!(r[0].command, "ls");
        assert_eq!(r[1].command, "ls -la");
    }

    // ---------- P1：核心场景（功能主路径） ----------
    #[test]
    fn p1_case_insensitive_match() {
        let data = vec![entry("git status", None, 1, 1)];
        assert!(matches_query("GIT", "git status", false));
        let r = search_history("GIT", &data, &opts(None, 10));
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].command, "git status");
    }

    #[test]
    fn p1_prefix_ranks_above_substring() {
        // "digit scan" 含子串 "git"（非前缀/非词边界），应排在 "git status"（前缀）之后
        let data = vec![entry("digit scan", None, 1, 1), entry("git status", None, 2, 1)];
        let r = search_history("git", &data, &opts(None, 10));
        assert_eq!(r[0].command, "git status");
        assert_eq!(r[1].command, "digit scan");
    }

    #[test]
    fn p1_recency_breaks_count_tie() {
        // 同频次，较新者优先
        let data = vec![
            entry("ssh old", Some("h1"), 100, 1),
            entry("ssh new", Some("h1"), 200, 1),
        ];
        let r = search_history("ssh", &data, &opts(Some("h1"), 10));
        assert_eq!(r[0].command, "ssh new");
    }

    // ---------- P2：边界值 ----------
    #[test]
    fn p2_empty_list_returns_empty() {
        let r = search_history("git", &[], &opts(None, 10));
        assert!(r.is_empty());
    }

    #[test]
    fn p2_no_match_returns_empty() {
        let data = vec![entry("ls -la", None, 1, 1)];
        let r = search_history("git", &data, &opts(None, 10));
        assert!(r.is_empty());
    }

    #[test]
    fn p2_single_entry_match() {
        let data = vec![entry("pwd", None, 1, 1)];
        let r = search_history("pw", &data, &opts(None, 10));
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn p2_whitespace_query_treated_as_empty() {
        let data = vec![entry("a", None, 1, 1), entry("b", None, 2, 1)];
        let r = search_history("   \t ", &data, &opts(None, 10));
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn p2_max_results_zero_returns_empty() {
        let data = vec![entry("ls", None, 1, 1)];
        let r = search_history("ls", &data, &opts(None, 0));
        assert!(r.is_empty());
    }

    #[test]
    fn p2_max_results_limits_output() {
        let data = vec![
            entry("git a", None, 1, 1),
            entry("git b", None, 2, 1),
            entry("git c", None, 3, 1),
        ];
        let r = search_history("git", &data, &opts(None, 2));
        assert_eq!(r.len(), 2);
    }

    // ---------- P3：组合 / 按主机隔离 ----------
    #[test]
    fn p3_host_isolation_keeps_target_and_local_only() {
        let data = vec![
            entry("tail -f app.log", Some("h1"), 1, 1),
            entry("systemctl restart svc", Some("h2"), 2, 1),
            entry("clear", None, 3, 1),
        ];
        let h1 = search_history("a", &data, &opts(Some("h1"), 10));
        assert_eq!(h1.len(), 2);
        assert!(h1.iter().any(|e| e.command == "tail -f app.log"));
        assert!(h1.iter().any(|e| e.command == "clear"));
        assert!(!h1.iter().any(|e| e.command.contains("systemctl")));

        let h2 = search_history("a", &data, &opts(Some("h2"), 10));
        assert_eq!(h2.len(), 2);
        assert!(h2.iter().any(|e| e.command.contains("systemctl")));
        assert!(h2.iter().any(|e| e.command == "clear"));

        // 全局检索可见全部
        let all = search_history("a", &data, &opts(None, 10));
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn p3_host_a_command_not_leaking_to_host_b() {
        // R-38 核心语义：主机 A 专属命令不应出现在主机 B 的检索中
        let data = vec![
            entry("dropdb prod", Some("prod-db"), 1, 1),
            entry("ls", Some("staging"), 2, 1),
        ];
        let b = search_history("dropdb", &data, &opts(Some("staging"), 10));
        assert!(b.is_empty(), "主机 B 不应看到主机 A 的专属命令");
    }

    #[test]
    fn p3_dedup_same_command_same_host() {
        let data = vec![
            entry("ls", Some("h1"), 1, 2),
            entry("ls", Some("h1"), 3, 3),
        ];
        let r = search_history("ls", &data, &opts(Some("h1"), 10));
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].use_count, 5);
        assert_eq!(r[0].timestamp, 3);
    }

    #[test]
    fn p3_dedup_case_insensitive() {
        let data = vec![entry("LS", None, 1, 1), entry("ls", None, 2, 4)];
        let r = search_history("ls", &data, &opts(None, 10));
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].use_count, 5);
    }

    #[test]
    fn p3_different_host_same_command_not_merged() {
        let data = vec![entry("ls", Some("h1"), 1, 1), entry("ls", Some("h2"), 2, 1)];
        let r = search_history("ls", &data, &opts(None, 10));
        assert_eq!(r.len(), 2);
    }

    // ---------- P4：防误报（正则元字符 / 特殊字符 / 多字节） ----------
    #[test]
    fn p4_regex_metachar_is_literal() {
        // "a.b" 作为字面匹配 "a.b"，但不应匹配 "axb"
        let data = vec![entry("a.b", None, 1, 1), entry("axb", None, 2, 1)];
        let r = search_history("a.b", &data, &opts(None, 10));
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].command, "a.b");
    }

    #[test]
    fn p4_special_chars_are_literal_substring() {
        let data = vec![entry("rm -rf /tmp/x", None, 1, 1)];
        let r = search_history("rm -rf /", &data, &opts(None, 10));
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn p4_unicode_substring() {
        let data = vec![
            entry("部署服务器", None, 1, 1),
            entry("部署前端", None, 2, 1),
            entry("回滚版本", None, 3, 1),
        ];
        let r = search_history("部署", &data, &opts(None, 10));
        assert_eq!(r.len(), 2);
        let r2 = search_history("回滚", &data, &opts(None, 10));
        assert_eq!(r2.len(), 1);
        assert_eq!(r2[0].command, "回滚版本");
    }

    #[test]
    fn p4_case_sensitive_mode() {
        let data = vec![entry("Git", None, 1, 1), entry("git", None, 2, 1)];
        let r = search_history("Git", &data, &HistoryQuery {
            host_filter: None,
            max_results: 10,
            case_sensitive: true,
        });
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].command, "Git");
    }

    // ---------- P5：极端 / 回归 ----------
    #[test]
    fn p5_large_dataset_is_stable_and_fast() {
        let mut data = Vec::with_capacity(5000);
        for i in 0..5000 {
            data.push(entry(
                &format!("cmd-{:05}", i % 200),
                Some("h1"),
                i as i64,
                1,
            ));
        }
        let r = search_history("cmd-00100", &data, &opts(Some("h1"), 50));
        // 200 条命中（i%200 == 100），去重后应只有 1 条（同命令同主机聚合）
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].use_count, 25); // 5000/200
    }

    #[test]
    fn p5_very_long_command_substring_match() {
        let big = "a".repeat(20000);
        let cmd = format!("git commit -m \"{}\"", big);
        let data = vec![entry(&cmd, None, 1, 1)];
        let r = search_history("git commit", &data, &opts(None, 10));
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn p5_many_hosts_isolation() {
        let mut data = Vec::new();
        for h in 0..100u32 {
            data.push(entry("ls", Some(&format!("host-{}", h)), h as i64, 1));
        }
        data.push(entry("clear", None, 999, 1));
        // 查询 "l" 同时命中 host-42 的 "ls" 与本地 "clear"
        let r = search_history("l", &data, &opts(Some("host-42"), 10));
        assert_eq!(r.len(), 2); // 仅 host-42 + 本地
        assert!(r.iter().any(|e| e.host_id.as_deref() == Some("host-42")));
        assert!(r.iter().any(|e| e.host_id.is_none()));
    }

    #[test]
    fn p5_crlf_in_command_matches_substring() {
        let data = vec![entry("ls\r\nrm -rf /", Some("h1"), 1, 1)];
        let r = search_history("rm -rf", &data, &opts(Some("h1"), 10));
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn p5_serialization_uses_camel_case() {
        let e = entry("ls", Some("h1"), 10, 3);
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["hostId"], "h1");
        assert_eq!(json["useCount"], 3);
        assert_eq!(json["timestamp"], 10);
    }
}
