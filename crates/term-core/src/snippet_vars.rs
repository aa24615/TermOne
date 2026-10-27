//! R-07 / IR-07 常用命令动态变量注入（纯逻辑，可单元测试）。
//!
//! 用户在 Snippets 中可写入占位符，连接时由客户端按当前会话上下文替换：
//!
//! ```text
//! {{host}} {{user}} {{port}} {{path}} {{cwd}}
//! {{date}} {{time}} {{datetime}}  ({{timestamp}} 同义)
//! {{env:NAME}}                   读取环境变量
//! ```
//!
//! 设计要点：
//! - 纯本地、不触网络、不落盘；单遍扫描返回渲染文本。
//! - 内置变量名大小写不敏感（`HOST`/`host` 等价）；`env:NAME` 的 `NAME` 大小写敏感。
//! - 未知占位符默认保留原样（便于发现拼写错误）；可选 `Strict` 模式对未知/缺失报错。
//! - `env` 取值不二次展开（防递归注入）；模板中的 `\{` 转义为字面 `{`。

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::error::{Result, TermError};

/// 片段渲染上下文：会话与运行时注入的变量值。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SnippetContext {
    pub host: Option<String>,
    pub user: Option<String>,
    pub port: Option<String>,
    pub path: Option<String>,
    pub cwd: Option<String>,
    pub date: Option<String>,
    pub time: Option<String>,
    pub datetime: Option<String>,
    /// 环境变量表；用于 `{{env:NAME}}`。生产环境由调用方读 `std::env` 填入。
    #[serde(default)]
    pub env: HashMap<String, String>,
}

impl SnippetContext {
    /// 从进程环境加载 `env` 表（其余字段留空）。生产调用。
    pub fn with_env() -> Self {
        let mut env = HashMap::new();
        for (k, v) in std::env::vars() {
            env.insert(k, v);
        }
        SnippetContext {
            env,
            ..Default::default()
        }
    }
}

/// 扩展模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExpandMode {
    /// 非严格：未知占位符保留原样，缺失内置变量 / 缺失 `env` 替换为空串。
    #[default]
    Lenient,
    /// 严格：遇到未知占位符或缺失内置变量 / 缺失 `env` 时报错。
    Strict,
}

/// 渲染错误（仅 `Strict` 模式产生）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExpandError {
    /// 未知占位符（`env:` 除外，env 名大小写敏感不存在即缺失）。
    UnknownVariable(String),
    /// 缺失的变量值（内置变量为 `None`，或 `env:NAME` 未提供）。
    MissingVariable(String),
}

impl fmt::Display for ExpandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ExpandError::UnknownVariable(v) => write!(f, "unknown snippet variable: {v}"),
            ExpandError::MissingVariable(v) => write!(f, "missing snippet variable: {v}"),
        }
    }
}

/// 内置变量名 → 取值。`Some(None)` 表示变量名已知但当前值为空（Lenient 下渲染为空串，
/// Strict 下报缺失）；`None` 表示未知变量名（Lenient 下原样保留）。
fn builtin_value(ctx: &SnippetContext, key: &str) -> Option<Option<String>> {
    match key.to_ascii_lowercase().as_str() {
        "host" => Some(ctx.host.clone()),
        "user" => Some(ctx.user.clone()),
        "port" => Some(ctx.port.clone()),
        "path" => Some(ctx.path.clone()),
        "cwd" => Some(ctx.cwd.clone()),
        "date" => Some(ctx.date.clone()),
        "time" => Some(ctx.time.clone()),
        "datetime" | "timestamp" => Some(ctx.datetime.clone()),
        _ => None,
    }
}

/// 主入口：以默认 `Lenient` 模式展开模板占位符。
pub fn expand_snippet(template: &str, ctx: &SnippetContext) -> Result<String> {
    expand_snippet_with(template, ctx, ExpandMode::Lenient)
}

/// 展开模板占位符，支持指定 `ExpandMode`。
pub fn expand_snippet_with(
    template: &str,
    ctx: &SnippetContext,
    mode: ExpandMode,
) -> Result<String> {
    let bytes = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut i = 0usize;
    while i < bytes.len() {
        // 转义：\{ -> 字面 {
        if bytes[i] == b'\\' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            out.push('{');
            i += 2;
            continue;
        }
        // 双花括号占位符 {{
        if bytes[i] == b'{' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if let Some(end) = find_closing(bytes, i + 2) {
                let raw = &template[i..end + 2]; // 含 {{...}}
                let inner = template[i + 2..end].trim(); // 去掉前后空白
                let expanded = resolve(raw, inner, ctx, mode)?;
                out.push_str(&expanded);
                i = end + 2;
                continue;
            }
            // 找不到闭合：保留原样（含开头的 {）
            let ch = template[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        // 普通字符（正确处理多字节 UTF-8）
        let ch = template[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    Ok(out)
}

/// 在 `from` 之后寻找首个 `}}` 闭合位置（返回第一个 `}` 的索引）。
fn find_closing(bytes: &[u8], from: usize) -> Option<usize> {
    let mut j = from;
    while j + 1 < bytes.len() {
        if bytes[j] == b'}' && bytes[j + 1] == b'}' {
            return Some(j);
        }
        j += 1;
    }
    None
}

/// 解析单个占位符的 `inner`（已 trim）；`raw` 用于 `Lenient` 模式下原样保留。
fn resolve(
    raw: &str,
    inner: &str,
    ctx: &SnippetContext,
    mode: ExpandMode,
) -> Result<String> {
    // 空占位符 {{}} / {{ }}：原样保留
    if inner.is_empty() {
        return Ok(raw.to_string());
    }
    let value = if let Some(name) = inner.strip_prefix("env:") {
        match ctx.env.get(name) {
            Some(v) => v.clone(),
            None => {
                if matches!(mode, ExpandMode::Strict) {
                    return Err(TermError::Other(
                        ExpandError::MissingVariable(format!("env:{name}")).to_string(),
                    ));
                }
                String::new()
            }
        }
    } else {
        match builtin_value(ctx, inner) {
            Some(Some(v)) => v,
            Some(None) => {
                // 已知变量名但当前值为空（None）
                if matches!(mode, ExpandMode::Strict) {
                    return Err(TermError::Other(
                        ExpandError::MissingVariable(inner.to_string()).to_string(),
                    ));
                }
                String::new()
            }
            None => {
                // 未知变量名
                if matches!(mode, ExpandMode::Strict) {
                    return Err(TermError::Other(
                        ExpandError::UnknownVariable(inner.to_string()).to_string(),
                    ));
                }
                // 未知变量：原样保留
                return Ok(raw.to_string());
            }
        }
    };
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> SnippetContext {
        let mut env = HashMap::new();
        env.insert("HOME".into(), "/home/u".into());
        env.insert("TERM".into(), "xterm-256color".into());
        env.insert("BIG".into(), "x".repeat(100_000));
        SnippetContext {
            host: Some("server1".into()),
            user: Some("alice".into()),
            port: Some("2222".into()),
            path: Some("/srv/app".into()),
            cwd: Some("/home/u/work".into()),
            date: Some("2026-10-28".into()),
            time: Some("13:45:09".into()),
            datetime: Some("2026-10-28T13:45:09Z".into()),
            env,
        }
    }

    // ===================== P0 正常路径 =====================
    #[test]
    fn p0_single_builtin() {
        let s = expand_snippet("ssh {{user}}@{{host}}", &ctx()).unwrap();
        assert_eq!(s, "ssh alice@server1");
    }

    #[test]
    fn p0_no_vars_untouched() {
        assert_eq!(expand_snippet("ls -la", &ctx()).unwrap(), "ls -la");
    }

    #[test]
    fn p0_preserves_surrounding_text() {
        let s = expand_snippet("echo {{host}} done", &ctx()).unwrap();
        assert_eq!(s, "echo server1 done");
    }

    #[test]
    fn p0_multiple_builtins() {
        let s = expand_snippet("ssh -p {{port}} {{user}}@{{host}}", &ctx()).unwrap();
        assert_eq!(s, "ssh -p 2222 alice@server1");
    }

    #[test]
    fn p0_path_and_cwd() {
        let s = expand_snippet("cd {{cwd}} && cat {{path}}/conf", &ctx()).unwrap();
        assert_eq!(s, "cd /home/u/work && cat /srv/app/conf");
    }

    #[test]
    fn p0_date_time_datetime() {
        let s = expand_snippet("{{date}} {{time}} {{datetime}}", &ctx()).unwrap();
        assert_eq!(s, "2026-10-28 13:45:09 2026-10-28T13:45:09Z");
    }

    // ===================== P1 核心指标 =====================
    #[test]
    fn p1_env_var() {
        assert_eq!(expand_snippet("echo $HOME={{env:HOME}}", &ctx()).unwrap(),
                   "echo $HOME=/home/u");
    }

    #[test]
    fn p1_case_insensitive_builtin() {
        // 内置变量名大小写不敏感
        assert_eq!(expand_snippet("{{HOST}}", &ctx()).unwrap(), "server1");
        assert_eq!(expand_snippet("{{User}}", &ctx()).unwrap(), "alice");
    }

    #[test]
    fn p1_env_name_case_sensitive() {
        // env 名大小写敏感：home 不存在
        assert_eq!(expand_snippet("{{env:home}}", &ctx()).unwrap(), "");
        assert_eq!(expand_snippet("{{env:TERM}}", &ctx()).unwrap(), "xterm-256color");
    }

    #[test]
    fn p1_timestamp_alias() {
        assert_eq!(expand_snippet("{{timestamp}}", &ctx()).unwrap(),
                   "2026-10-28T13:45:09Z");
    }

    // ===================== P2 边界 =====================
    #[test]
    fn p2_missing_builtin_empty() {
        let c = SnippetContext::default();
        assert_eq!(expand_snippet("ssh {{host}}", &c).unwrap(), "ssh ");
    }

    #[test]
    fn p2_unclosed_kept_literally() {
        // 无闭合 }}：原样保留，包括开头的 {
        assert_eq!(expand_snippet("{{host", &ctx()).unwrap(), "{{host");
        assert_eq!(expand_snippet("a {{host", &ctx()).unwrap(), "a {{host");
    }

    #[test]
    fn p2_empty_template() {
        assert_eq!(expand_snippet("", &ctx()).unwrap(), "");
    }

    #[test]
    fn p2_empty_inner_kept() {
        // {{}} 与 {{ }} 均原样保留
        assert_eq!(expand_snippet("x{{}}y", &ctx()).unwrap(), "x{{}}y");
        assert_eq!(expand_snippet("x{{ }}y", &ctx()).unwrap(), "x{{ }}y");
    }

    #[test]
    fn p2_missing_env_empty() {
        assert_eq!(expand_snippet("{{env:NOPE}}", &ctx()).unwrap(), "");
    }

    #[test]
    fn p2_lone_brace_preserved() {
        // 单 { 不是占位符
        assert_eq!(expand_snippet("if [ {x} ]; then", &ctx()).unwrap(),
                   "if [ {x} ]; then");
    }

    // ===================== P3 组合 / 单位 =====================
    #[test]
    fn p3_mixed_builtin_and_env() {
        let s = expand_snippet(
            "# connect {{user}}@{{host}}:{{port}} term={{env:TERM}}",
            &ctx(),
        )
        .unwrap();
        assert_eq!(s, "# connect alice@server1:2222 term=xterm-256color");
    }

    #[test]
    fn p3_unknown_kept_lenient() {
        assert_eq!(expand_snippet("run {{foobar}} now", &ctx()).unwrap(),
                   "run {{foobar}} now");
    }

    #[test]
    fn p3_strict_unknown_errors() {
        let r = expand_snippet_with("{{foobar}}", &ctx(), ExpandMode::Strict);
        assert!(matches!(r, Err(TermError::Other(_))));
        assert!(r.unwrap_err().to_string().contains("foobar"));
    }

    #[test]
    fn p3_strict_missing_env_errors() {
        let r = expand_snippet_with("{{env:NOPE}}", &ctx(), ExpandMode::Strict);
        assert!(r.is_err());
        assert!(r.unwrap_err().to_string().contains("env:NOPE"));
    }

    #[test]
    fn p3_strict_valid_ok() {
        let s = expand_snippet_with("{{user}}@{{host}}", &ctx(), ExpandMode::Strict).unwrap();
        assert_eq!(s, "alice@server1");
    }

    // ===================== P4 防误报 / 鲁棒性 =====================
    #[test]
    fn p4_whitespace_inside_braces() {
        assert_eq!(expand_snippet("{{ host }}", &ctx()).unwrap(), "server1");
        assert_eq!(expand_snippet("{{  user  }}", &ctx()).unwrap(), "alice");
    }

    #[test]
    fn p4_escape_brace() {
        // \{ 转义为字面 {
        assert_eq!(expand_snippet(r"a \{ b {{host}}", &ctx()).unwrap(),
                   "a { b server1");
    }

    #[test]
    fn p4_lone_backslash_preserved() {
        // 单个反斜杠（非转义序列）应原样保留
        assert_eq!(expand_snippet(r"a\b", &ctx()).unwrap(), "a\\b");
    }

    #[test]
    fn p4_no_reentry_on_env_value() {
        // env 值中若含占位符，不二次展开
        let mut c = SnippetContext::default();
        c.env.insert("FOO".into(), "{{host}}".into());
        c.host = Some("real".into());
        assert_eq!(expand_snippet("{{env:FOO}}", &c).unwrap(), "{{host}}");
    }

    #[test]
    fn p4_nested_braces_preserved() {
        // 畸形嵌套：整体原样保留，不 panic
        assert_eq!(expand_snippet("{{a{{b}}", &ctx()).unwrap(), "{{a{{b}}");
    }

    #[test]
    fn p4_with_env_loads_process_env() {
        // 不依赖具体变量名，仅验证不 panic 且为空模板时不改变
        let c = SnippetContext::with_env();
        assert_eq!(expand_snippet("plain", &c).unwrap(), "plain");
    }

    // ===================== P5 极端 / 回归 =====================
    #[test]
    fn p5_many_vars() {
        let mut t = String::new();
        for _ in 0..500 {
            t.push_str("{{host}} ");
        }
        let s = expand_snippet(&t, &ctx()).unwrap();
        let expected: String = std::iter::repeat("server1 ").take(500).collect();
        assert_eq!(s.trim_end(), expected.trim_end());
    }

    #[test]
    fn p5_unicode_value() {
        let mut c = SnippetContext::default();
        c.host = Some("服务器-中文".into());
        assert_eq!(expand_snippet("ssh root@{{host}}", &c).unwrap(),
                   "ssh root@服务器-中文");
    }

    #[test]
    fn p5_crlf_preserved() {
        let s = expand_snippet("line1\r\n{{host}}\r\nline3", &ctx()).unwrap();
        assert_eq!(s, "line1\r\nserver1\r\nline3");
    }

    #[test]
    fn p5_large_env_value_no_panic() {
        let s = expand_snippet("P={{env:BIG}}", &ctx()).unwrap();
        assert!(s.starts_with("P=xxxx"));
        assert_eq!(s.len(), "P=".len() + 100_000);
    }

    #[test]
    fn p5_utf8_multibyte_scan() {
        // 多字节字符后紧跟占位符
        let s = expand_snippet("中文{{host}}结尾", &ctx()).unwrap();
        assert_eq!(s, "中文server1结尾");
    }
}
