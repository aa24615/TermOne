//! 命令安全分类器：多行粘贴保护 + 危险命令二次确认。
//!
//! 纯逻辑、零 I/O、无额外依赖，便于单元测试，并可在会话输入层（桌面端 / Web 端通用）
//! 复用。对应需求 **R-26（多行粘贴保护 + 危险命令二次确认）**。
//!
//! 设计原则：
//! - **保守优先**：宁可少报不可漏报高危命令；误报只会多一次确认，漏报则可能误删。
//! - **不解析完整 shell 语法**：仅做「去注释 + 去引号字面量 + 关键字 / 子串扫描」，足以覆盖绝大多数误操作。
//! - **跨平台一致**：不依赖具体 shell，规则对 bash / zsh / sh 均适用。
//!
//! 已知边界（保守策略的代价，均为「多一次确认」而非漏报）：
//! - 单行内以 `;` / `&&` / `||` 串联的多条命令不算「多行粘贴」（多行仅按换行判定，贴合 R-26 语义）。
//! - 针对分区工具的匹配为词首匹配，正常文本中若恰好出现 `mkfs` / `fdisk` 等词仍会提示，属可接受误报。

/// 风险等级（由低到高）。UI 据此决定弹窗强度与文案。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RiskLevel {
    /// 单条、无风险命令
    Safe = 0,
    /// 需谨慎：多行粘贴（可能误执行多条）或可逆 / 低危操作
    Caution = 1,
    /// 高危：不可逆、破坏性操作（删除、格式化、覆盖设备等）
    Danger = 2,
}

/// 触发风险的具体原因，UI 可据此给出针对性文案与审计记录。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
#[derive(Debug, Clone, PartialEq, Eq)]
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
    let mut reasons: Vec<RiskReason> = Vec::new();
    let mut statement_count = 0usize;

    for raw_line in input.split('\n') {
        let normalized = normalize_line(raw_line);
        let trimmed = normalized.trim();
        if trimmed.is_empty() {
            continue;
        }
        statement_count += 1;
        let low = trimmed.to_ascii_lowercase();
        collect_danger(&low, &mut reasons);
    }

    let multi_line = statement_count > 1;
    if multi_line {
        reasons.push(RiskReason::MultiLinePaste);
    }

    let risk = if reasons.iter().any(|r| is_danger(*r)) {
        RiskLevel::Danger
    } else if multi_line || reasons.iter().any(|r| is_caution(*r)) {
        RiskLevel::Caution
    } else {
        RiskLevel::Safe
    };

    CommandCheck {
        statement_count,
        multi_line,
        risk,
        reasons,
    }
}

/// 剥离注释与引号字面量：
/// - 单引号 / 双引号内的内容直接丢弃（避免误判引号里的危险词）；
/// - 不在引号内、且位于行首或分隔符后的 `#` 视为注释起点，其后整行丢弃。
fn normalize_line(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut in_single = false;
    let mut in_double = false;
    let mut i = 0;
    let n = bytes.len();
    while i < n {
        let c = bytes[i];
        match c {
            b'\'' => {
                in_single = !in_single;
                i += 1;
            }
            b'"' => {
                in_double = !in_double;
                i += 1;
            }
            b'#' if !in_single && !in_double => {
                let prev = if i > 0 { bytes[i - 1] } else { b' ' };
                let boundary = i == 0
                    || prev == b' '
                    || prev == b'\t'
                    || prev == b';'
                    || prev == b'|'
                    || prev == b'&'
                    || prev == b'('
                    || prev == b'{';
                if boundary {
                    break; // 注释到行尾
                }
                out.push('#');
                i += 1;
            }
            _ => {
                if !(in_single || in_double) {
                    out.push(c as char);
                }
                i += 1;
            }
        }
    }
    out
}

/// 在已去注释 / 去引号并小写化的单行上扫描危险模式。
fn collect_danger(line: &str, out: &mut Vec<RiskReason>) {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let has = |t: &str| tokens.contains(&t);

    // 递归删除
    if has("rm")
        && (has("-r")
            || has("-R")
            || has("--recursive")
            || has("-rf")
            || has("-fr")
            || has("-fR")
            || has("-Rf"))
    {
        out.push(RiskReason::RecursiveDelete);
    }

    // 格式化 / 分区工具（词首 / 精确匹配，避免 mymkfs 之类误报）
    let disk_tool = tokens.iter().any(|t| {
        t.starts_with("mkfs")
            || t.starts_with("mke2fs")
            || *t == "fdisk"
            || *t == "parted"
            || t.starts_with("cfdisk")
            || t.starts_with("sfdisk")
    });
    if disk_tool {
        out.push(RiskReason::FormatFilesystem);
    }

    // 直接写盘
    if has("dd") {
        out.push(RiskReason::DiskOverwrite);
    }

    // Fork 炸弹
    if line.contains(":(){") || line.contains(": (){") || line.contains(":(){:") {
        out.push(RiskReason::ForkBomb);
    }

    // 重定向到设备文件
    if line.contains(">/dev/")
        || line.contains("> /dev/")
        || line.contains(">>/dev/")
        || line.contains(">> /dev/")
    {
        out.push(RiskReason::DeviceRedirect);
    }

    // 电源 / 关机控制
    if has("shutdown")
        || has("reboot")
        || has("halt")
        || has("poweroff")
        || line.contains("init 0")
        || line.contains("init 6")
    {
        out.push(RiskReason::PowerControl);
    }

    // 下载后直接喂给 shell
    if (line.contains("curl") || line.contains("wget"))
        && (line.contains("|sh")
            || line.contains("| sh")
            || line.contains("|bash")
            || line.contains("| bash"))
    {
        out.push(RiskReason::PipeToShell);
    }

    // 破坏性 git 操作
    if has("git")
        && (line.contains("reset --hard")
            || line.contains("clean -f")
            || line.contains("clean -fd")
            || line.contains("clean -fdx")
            || line.contains("push -f")
            || line.contains("push --force")
            || line.contains("checkout --"))
    {
        out.push(RiskReason::ForceGit);
    }

    // 权限清零 / 递归改权限（行已小写化，故 -R 应写作 -r）
    if has("chmod") && (has("-r") || has("--recursive") || line.contains("chmod 0")) {
        out.push(RiskReason::ZeroPerms);
    }
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
