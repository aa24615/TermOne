//! 命令安全分类器：多行粘贴保护 + 危险命令二次确认。
//!
//! 纯逻辑、零 I/O、无额外依赖，便于单元测试，并可在会话输入层（桌面端 / Web 端通用）
//! 复用。对应需求 **R-26（多行粘贴保护 + 危险命令二次确认）**。
//!
//! 设计原则：
//! - **保守提示**：对可识别的高风险模式要求确认，不能代替完整 shell 语义或权限隔离。
//! - **不解析完整 shell 语法**：保留引号词、识别常见命令替换和 shell 包装；变量展开、别名和远端状态仍有边界。
//! - **跨平台一致**：不依赖具体 shell，规则对 bash / zsh / sh 均适用。
//!
//! 已知边界（保守策略的代价，均为「多一次确认」而非漏报）：
//! - 单行内以 `;` / `&&` / `||` 串联的多条命令不算「多行粘贴」（多行仅按换行判定，贴合 R-26 语义）。
//! - 针对分区工具的匹配为词首匹配，正常文本中若恰好出现 `mkfs` / `fdisk` 等词仍会提示，属可接受误报。

use serde::Serialize;

/// 风险等级（由低到高）。UI 据此决定弹窗强度与文案。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RiskLevel {
    /// 单条、无风险命令
    Safe = 0,
    /// 需谨慎：多行粘贴（可能误执行多条）或可逆 / 低危操作
    Caution = 1,
    /// 高危：不可逆、破坏性操作（删除、格式化、覆盖设备等）
    Danger = 2,
}

/// 触发风险的具体原因，UI 可据此给出针对性文案与审计记录。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RiskReason {
    /// 多行粘贴（可能误执行多条命令）
    MultiLinePaste,
    /// 递归删除（rm -r/-R/--recursive 等）
    RecursiveDelete,
    /// 格式化 / 分区工具（mkfs / fdisk / parted 等）
    FormatFilesystem,
    /// 直接写盘（dd）
    DiskOverwrite,
    /// Fork 炸弹
    ForkBomb,
    /// 重定向到设备文件（> /dev/...）
    DeviceRedirect,
    /// 电源 / 关机控制（shutdown / reboot / halt / poweroff / init 0|6）
    PowerControl,
    /// 下载后直接喂给 shell（curl|sh / wget|bash）
    PipeToShell,
    /// 破坏性 git 操作（reset --hard / clean -f / push --force / checkout --）
    ForceGit,
    /// 权限清零或递归改权限（chmod 0... / chmod -R）
    ZeroPerms,
}

/// 单条输入（一次粘贴 / 一次回车提交）的检查结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCheck {
    /// 去注释 / 去引号后，非空的有效语句数（按换行计）
    pub statement_count: usize,
    /// 是否多行粘贴（statement_count > 1）
    pub multi_line: bool,
    /// 综合风险等级
    pub risk: RiskLevel,
    /// 命中的全部原因（可能同时含多行与高危）
    pub reasons: Vec<RiskReason>,
}

impl CommandCheck {
    /// 是否需要二次确认。Safe 为 false，Caution / Danger 为 true。
    pub fn needs_confirmation(&self) -> bool {
        self.risk != RiskLevel::Safe
    }
}

/// 对一次用户输入做安全分类。
///
/// `input` 为终端输入框的当前内容（可能含多行，例如一次粘贴）。
/// 返回的风险等级与原因可直接驱动 UI 的二次确认弹窗。
pub fn classify_command(input: &str) -> CommandCheck {
    classify(input, 0)
}

fn classify(input: &str, depth: usize) -> CommandCheck {
    let input = input.replace("\r\n", "\n").replace('\r', "\n");
    let mut reasons = Vec::new();
    let statement_count = input
        .lines()
        .filter(|line| {
            shell_tokens(line)
                .iter()
                .any(|t| ![";", "|", "&"].contains(&t.as_str()))
        })
        .count();
    collect_danger(&input, &mut reasons);
    if depth < 8 {
        for nested in substitutions(&input) {
            for reason in classify(&nested, depth + 1).reasons {
                if reason != RiskReason::MultiLinePaste {
                    reasons.push(reason);
                }
            }
        }
        let tokens = shell_tokens(&input.to_ascii_lowercase());
        let first = tokens.first().map(|s| base(s));
        if !matches!(first, Some("echo" | "printf"))
            && tokens.iter().any(|t| {
                matches!(
                    base(t),
                    "sh" | "bash" | "zsh" | "dash" | "ksh" | "powershell" | "pwsh" | "cmd"
                )
            })
        {
            if let Some(i) = tokens
                .iter()
                .position(|t| matches!(t.as_str(), "-c" | "-command" | "/c"))
            {
                if let Some(command) = tokens.get(i + 1) {
                    reasons.extend(
                        classify(command, depth + 1)
                            .reasons
                            .into_iter()
                            .filter(|r| *r != RiskReason::MultiLinePaste),
                    );
                }
            }
        }
    }
    let multi_line = statement_count > 1;
    if multi_line {
        reasons.push(RiskReason::MultiLinePaste);
    }
    let mut unique = Vec::new();
    for reason in reasons {
        if !unique.contains(&reason) {
            unique.push(reason);
        }
    }
    let risk = if unique.iter().any(|r| is_danger(*r)) {
        RiskLevel::Danger
    } else if unique.iter().any(|r| is_caution(*r)) {
        RiskLevel::Caution
    } else {
        RiskLevel::Safe
    };
    CommandCheck {
        statement_count,
        multi_line,
        risk,
        reasons: unique,
    }
}

// Preserve quoted arguments as single words, so a quoted executable/option is
// checked but `echo 'rm -rf /'` is not mistaken for executing rm. This is a
// heuristic, not a shell parser or an execution security boundary.
fn shell_tokens(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && quote != Some('\'') {
            if let Some(next) = chars.next() {
                if next != '\n' {
                    word.push(next);
                }
            }
        } else if quote == Some(c) {
            quote = None;
        } else if quote.is_none() && (c == '\'' || c == '"') {
            quote = Some(c);
        } else if quote.is_none() && c == '#' && word.is_empty() {
            for next in chars.by_ref() {
                if next == '\n' {
                    break;
                }
            }
            tokens.push(";".into());
        } else if quote.is_none() && (c.is_whitespace() || ";|&(){}<>".contains(c)) {
            if !word.is_empty() {
                tokens.push(std::mem::take(&mut word));
            }
            if c == '\n' {
                tokens.push(";".into());
            } else if !c.is_whitespace() {
                tokens.push(c.to_string());
            }
        } else {
            word.push(c);
        }
    }
    if !word.is_empty() {
        tokens.push(word);
    }
    tokens
}
fn base(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

fn collect_danger(input: &str, out: &mut Vec<RiskReason>) {
    let lower = input.to_ascii_lowercase();
    let tokens = shell_tokens(&lower);
    let has = |t: &str| tokens.iter().any(|v| base(v) == t);
    // Literal text printed by echo/printf is harmless; substitutions are checked separately.
    if matches!(tokens.first().map(|t| base(t)), Some("echo" | "printf"))
        && !tokens
            .iter()
            .any(|t| [";", "|", "&", ">", "<", "("].contains(&t.as_str()))
    {
        return;
    }
    let recursive = tokens.iter().any(|t| {
        t == "--recursive"
            || t == "-recurse"
            || (t.starts_with('-') && !t.starts_with("--") && t[1..].contains('r'))
    });
    if ((has("rm") || has("remove-item")) && recursive)
        || ((has("rd") || has("rmdir") || has("del")) && has("s"))
    {
        out.push(RiskReason::RecursiveDelete);
    }
    if tokens.iter().any(|t| {
        let b = base(t);
        b == "mkfs"
            || b.starts_with("mkfs.")
            || [
                "mke2fs",
                "fdisk",
                "parted",
                "cfdisk",
                "sfdisk",
                "format",
                "format-volume",
                "clear-disk",
            ]
            .contains(&b)
    }) {
        out.push(RiskReason::FormatFilesystem);
    }
    if has("dd") {
        out.push(RiskReason::DiskOverwrite);
    }
    if lower.replace([' ', '\t'], "").contains(":(){") {
        out.push(RiskReason::ForkBomb);
    }
    if tokens.windows(2).any(|w| {
        w[0] == ">"
            && w[1].starts_with("/dev/")
            && !["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"].contains(&w[1].as_str())
    }) {
        out.push(RiskReason::DeviceRedirect);
    }
    if [
        "shutdown",
        "reboot",
        "halt",
        "poweroff",
        "stop-computer",
        "restart-computer",
    ]
    .iter()
    .any(|t| has(t))
        || tokens
            .windows(2)
            .any(|w| base(&w[0]) == "init" && ["0", "6"].contains(&w[1].as_str()))
    {
        out.push(RiskReason::PowerControl);
    }
    if (has("curl") || has("wget"))
        && has("|")
        && ["sh", "bash", "zsh", "dash", "pwsh", "powershell"]
            .iter()
            .any(|t| has(t))
    {
        out.push(RiskReason::PipeToShell);
    }
    if has("git")
        && ((has("reset") && has("--hard"))
            || (has("clean")
                && tokens
                    .iter()
                    .any(|t| t.starts_with('-') && !t.starts_with("--") && t.contains('f')))
            || (has("push")
                && tokens.iter().any(|t| {
                    t == "--force"
                        || t.starts_with("--force-with-lease")
                        || (t.starts_with('-') && !t.starts_with("--") && t.contains('f'))
                }))
            || (has("checkout") && has("--")))
    {
        out.push(RiskReason::ForceGit);
    }
    if has("chmod")
        && (recursive
            || tokens
                .iter()
                .any(|t| t.starts_with('0') && t.chars().all(|c| matches!(c, '0'..='7'))))
    {
        out.push(RiskReason::ZeroPerms);
    }
}

fn substitutions(input: &str) -> Vec<String> {
    let chars: Vec<char> = input.chars().collect();
    let mut found = Vec::new();
    let mut i = 0;
    let mut quote = None;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && quote != Some('\'') {
            i += 2;
            continue;
        }
        if quote == Some(c) {
            quote = None;
            i += 1;
            continue;
        }
        if quote.is_none() && (c == '\'' || c == '"') {
            quote = Some(c);
            i += 1;
            continue;
        }
        if quote.is_none()
            && c == '#'
            && (i == 0 || chars[i - 1].is_whitespace() || ";|&".contains(chars[i - 1]))
        {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if quote != Some('\'') && (c == '`' || (c == '$' && chars.get(i + 1) == Some(&'('))) {
            let backtick = c == '`';
            let start = i + if backtick { 1 } else { 2 };
            let mut end = start;
            let mut nesting = 1;
            let mut inner_quote = None;
            while end < chars.len() {
                let ch = chars[end];
                if ch == '\\' {
                    end += 2;
                    continue;
                }
                if backtick && ch == '`' {
                    break;
                }
                if !backtick {
                    if inner_quote == Some(ch) {
                        inner_quote = None;
                    } else if inner_quote.is_none() && (ch == '\'' || ch == '"') {
                        inner_quote = Some(ch);
                    } else if inner_quote.is_none() && ch == '(' {
                        nesting += 1;
                    } else if inner_quote.is_none() && ch == ')' {
                        nesting -= 1;
                        if nesting == 0 {
                            break;
                        }
                    }
                }
                end += 1;
            }
            found.push(chars[start..end.min(chars.len())].iter().collect());
            i = end + 1;
        } else {
            i += 1;
        }
    }
    found
}

fn is_danger(r: RiskReason) -> bool {
    matches!(
        r,
        RiskReason::RecursiveDelete
            | RiskReason::FormatFilesystem
            | RiskReason::DiskOverwrite
            | RiskReason::ForkBomb
            | RiskReason::DeviceRedirect
            | RiskReason::PowerControl
            | RiskReason::PipeToShell
            | RiskReason::ForceGit
    )
}

fn is_caution(r: RiskReason) -> bool {
    matches!(r, RiskReason::MultiLinePaste | RiskReason::ZeroPerms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn r26_quoted_paths_options_and_compound_commands_cannot_hide_deletion() {
        for input in [
            "/bin/rm -rI /tmp/x",
            "'rm' '-rf' /tmp/x",
            "echo ok;rm -rf /tmp/x",
            "sudo /bin/rm --recursive /tmp/x",
            "Remove-Item -Recurse C:/temp/x",
            "rmdir /s C:/temp/x",
        ] {
            assert!(
                classify_command(input)
                    .reasons
                    .contains(&RiskReason::RecursiveDelete),
                "{input}"
            );
        }
    }
    #[test]
    fn r26_executable_substitutions_and_shell_wrappers_are_checked() {
        for input in [
            "echo \"$(rm -rf /tmp/x)\"",
            "echo `rm -rf /tmp/x`",
            "echo <(rm -rf /tmp/x)",
            "sh -c 'rm -rf /tmp/x'",
            "bash -c \"reboot\"",
            "curl https://example.test/a | /bin/bash",
        ] {
            assert_eq!(classify_command(input).risk, RiskLevel::Danger, "{input}");
        }
    }
    #[test]
    fn r26_literal_examples_and_comments_remain_safe() {
        for input in [
            "echo '$(rm -rf /)'",
            "echo \"rm -rf /\"",
            "printf '%s' 'reboot'",
            "# echo $(reboot)",
            "echo ok >/dev/null",
            "echo '中文说明'",
            "echo rm -rf /",
        ] {
            assert_eq!(classify_command(input).risk, RiskLevel::Safe, "{input}");
        }
    }
    #[test]
    fn r26_crlf_and_repeated_reasons_are_normalized() {
        let check = classify_command("rm -rf /tmp/a\r\nrm -rf /tmp/b");
        assert_eq!(check.statement_count, 2);
        assert!(check.multi_line);
        assert_eq!(
            check
                .reasons
                .iter()
                .filter(|r| **r == RiskReason::RecursiveDelete)
                .count(),
            1
        );
        assert_eq!(
            classify_command("git push origin --force").risk,
            RiskLevel::Danger
        );
        assert_eq!(classify_command("echo x >/dev/sdb").risk, RiskLevel::Danger);
    }
    #[test]
    fn r26_ipc_serialization_uses_stable_camel_case_names() {
        let json = serde_json::to_value(classify_command("rm -rf /tmp/x")).unwrap();
        assert_eq!(json["risk"], "danger");
        assert_eq!(json["reasons"][0], "recursiveDelete");
        assert_eq!(json["statementCount"], 1);
    }

    // ---------- P0：正常路径 / 日常使用 ----------
    #[test]
    fn p0_single_safe_command() {
        let c = classify_command("ls -la");
        assert_eq!(c.risk, RiskLevel::Safe);
        assert!(!c.multi_line);
        assert!(!c.needs_confirmation());
        assert!(c.reasons.is_empty());
    }

    #[test]
    fn p0_everyday_pipeline() {
        let c = classify_command("cd ~/projects && npm run dev");
        assert_eq!(c.risk, RiskLevel::Safe);
        assert_eq!(c.statement_count, 1);
    }

    #[test]
    fn p0_full_line_comment() {
        let c = classify_command("# backup everything now");
        assert_eq!(c.risk, RiskLevel::Safe);
        assert_eq!(c.statement_count, 0);
        assert!(!c.multi_line);
    }

    // ---------- P1：核心危险场景（功能主路径） ----------
    #[test]
    fn p1_recursive_delete() {
        let c = classify_command("rm -rf /tmp/foo");
        assert_eq!(c.risk, RiskLevel::Danger);
        assert!(c.reasons.contains(&RiskReason::RecursiveDelete));
        assert!(c.needs_confirmation());
    }

    #[test]
    fn p1_recursive_delete_fr_variant() {
        let c = classify_command("rm -fr node_modules");
        assert_eq!(c.risk, RiskLevel::Danger);
        assert!(c.reasons.contains(&RiskReason::RecursiveDelete));
    }

    #[test]
    fn p1_dd_overwrite() {
        let c = classify_command("dd if=/dev/zero of=/dev/sda");
        assert_eq!(c.risk, RiskLevel::Danger);
        assert!(c.reasons.contains(&RiskReason::DiskOverwrite));
    }

    #[test]
    fn p1_format() {
        let c = classify_command("mkfs.ext4 /dev/sdb1");
        assert_eq!(c.risk, RiskLevel::Danger);
        assert!(c.reasons.contains(&RiskReason::FormatFilesystem));
    }

    #[test]
    fn p1_poweroff() {
        let c = classify_command("sudo reboot");
        assert_eq!(c.risk, RiskLevel::Danger);
        assert!(c.reasons.contains(&RiskReason::PowerControl));
    }

    #[test]
    fn p1_pipe_to_shell() {
        let c = classify_command("curl https://example.com/x.sh | sh");
        assert_eq!(c.risk, RiskLevel::Danger);
        assert!(c.reasons.contains(&RiskReason::PipeToShell));
    }

    #[test]
    fn p1_git_force() {
        let c = classify_command("git reset --hard HEAD~3");
        assert_eq!(c.risk, RiskLevel::Danger);
        assert!(c.reasons.contains(&RiskReason::ForceGit));
    }

    // ---------- P2：边界值 ----------
    #[test]
    fn p2_multiline_paste_safe() {
        let c = classify_command("echo hello\nls -la");
        assert_eq!(c.risk, RiskLevel::Caution);
        assert!(c.multi_line);
        assert_eq!(c.statement_count, 2);
        assert!(c.reasons.contains(&RiskReason::MultiLinePaste));
        assert!(c.needs_confirmation());
    }

    #[test]
    fn p2_normal_rm_safe() {
        // 非递归删除不应被拦截
        let c = classify_command("rm file.txt");
        assert_eq!(c.risk, RiskLevel::Safe);
        assert!(!c.reasons.contains(&RiskReason::RecursiveDelete));
    }

    #[test]
    fn p2_empty_input() {
        let c = classify_command("");
        assert_eq!(c.risk, RiskLevel::Safe);
        assert_eq!(c.statement_count, 0);
        assert!(!c.multi_line);
    }

    #[test]
    fn p2_whitespace_only() {
        let c = classify_command("   \n  \t ");
        assert_eq!(c.risk, RiskLevel::Safe);
        assert_eq!(c.statement_count, 0);
    }

    #[test]
    fn p2_single_line_semicolon_not_multiline() {
        // 单行内以 ; 串联不计入「多行粘贴」
        let c = classify_command("cd a; ls");
        assert_eq!(c.risk, RiskLevel::Safe);
        assert!(!c.multi_line);
        assert_eq!(c.statement_count, 1);
    }

    // ---------- P3：组合与前缀 ----------
    #[test]
    fn p3_multiline_with_danger() {
        let c = classify_command("echo start\nrm -rf /");
        assert_eq!(c.risk, RiskLevel::Danger);
        assert!(c.multi_line);
        assert!(c.reasons.contains(&RiskReason::MultiLinePaste));
        assert!(c.reasons.contains(&RiskReason::RecursiveDelete));
    }

    #[test]
    fn p3_sudo_prefix_danger() {
        // sudo 等前缀不得掩盖危险命令
        let c = classify_command("sudo rm -rf /var/log/*");
        assert_eq!(c.risk, RiskLevel::Danger);
        assert!(c.reasons.contains(&RiskReason::RecursiveDelete));
    }

    #[test]
    fn p3_env_prefix_danger() {
        let c = classify_command("FOO=bar rm -rf tmp");
        assert_eq!(c.risk, RiskLevel::Danger);
        assert!(c.reasons.contains(&RiskReason::RecursiveDelete));
    }

    #[test]
    fn p3_nested_pipe_danger() {
        let c = classify_command("cat a | grep x | xargs rm -rf");
        assert_eq!(c.risk, RiskLevel::Danger);
        assert!(c.reasons.contains(&RiskReason::RecursiveDelete));
    }

    // ---------- P4：防误报（注释 / 引号 / 子串） ----------
    #[test]
    fn p4_full_comment_danger_hidden() {
        let c = classify_command("# rm -rf /");
        assert_eq!(c.risk, RiskLevel::Safe);
        assert_eq!(c.statement_count, 0);
    }

    #[test]
    fn p4_inline_comment_danger_detected() {
        // 命令本身危险，行尾注释不改变其危险性
        let c = classify_command("rm -rf / # oops, do not run");
        assert_eq!(c.risk, RiskLevel::Danger);
        assert!(c.reasons.contains(&RiskReason::RecursiveDelete));
    }

    #[test]
    fn p4_single_quoted_danger_safe() {
        let c = classify_command("echo 'rm -rf /'");
        assert_eq!(c.risk, RiskLevel::Safe);
    }

    #[test]
    fn p4_double_quoted_danger_safe() {
        let c = classify_command("echo \"rm -rf /\"");
        assert_eq!(c.risk, RiskLevel::Safe);
    }

    #[test]
    fn p4_dd_substring_safe() {
        // oddd 不是 dd 命令，不应误报
        let c = classify_command("echo oddd");
        assert_eq!(c.risk, RiskLevel::Safe);
    }

    // ---------- P5：极端 / 回归 ----------
    #[test]
    fn p5_huge_multiline_detects_danger() {
        let mut input = String::new();
        for i in 0..1000 {
            input.push_str(&format!("echo line{}\n", i));
        }
        input.push_str("rm -rf /");
        let c = classify_command(&input);
        assert_eq!(c.risk, RiskLevel::Danger);
        assert!(c.multi_line);
        assert!(c.reasons.contains(&RiskReason::RecursiveDelete));
    }

    #[test]
    fn p5_chmod_recursive_caution() {
        let c = classify_command("chmod -R 755 dir");
        assert_eq!(c.risk, RiskLevel::Caution);
        assert!(c.reasons.contains(&RiskReason::ZeroPerms));
        assert!(!c.reasons.contains(&RiskReason::RecursiveDelete));
    }

    #[test]
    fn p5_chmod_zero_caution() {
        let c = classify_command("chmod 000 secret");
        assert_eq!(c.risk, RiskLevel::Caution);
        assert!(c.reasons.contains(&RiskReason::ZeroPerms));
    }

    #[test]
    fn p5_parted_danger() {
        let c = classify_command("parted /dev/sda mklabel gpt");
        assert_eq!(c.risk, RiskLevel::Danger);
        assert!(c.reasons.contains(&RiskReason::FormatFilesystem));
    }

    #[test]
    fn p5_leading_whitespace_danger() {
        let c = classify_command("    rm -rf /");
        assert_eq!(c.risk, RiskLevel::Danger);
        assert!(c.reasons.contains(&RiskReason::RecursiveDelete));
    }

    #[test]
    fn p5_utf8_comment_safe() {
        // 中文注释 + 多字节不应影响判断
        let c = classify_command("# 中文说明：列出文件\nls -la");
        assert_eq!(c.risk, RiskLevel::Safe);
        assert_eq!(c.statement_count, 1);
    }

    // ---------- 辅助：needs_confirmation 语义 ----------
    #[test]
    fn helper_needs_confirmation_semantics() {
        assert!(!classify_command("ls").needs_confirmation());
        assert!(classify_command("echo a\nls").needs_confirmation()); // Caution
        assert!(classify_command("rm -rf /").needs_confirmation()); // Danger
    }
}
