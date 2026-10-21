export const GITHUB_URL = "https://github.com/aa24615/TermOne";
export const GITHUB_ISSUES_URL = "https://github.com/aa24615/TermOne/issues";

export interface ChangelogEntry {
  version: string;
  date: string;
  items: string[];
}

/** 版本更新记录：发新版本时在最上方追加条目（About 对话框读取）。 */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.1.0",
    date: "2026-10-21",
    items: [
      "本地终端：PowerShell / pwsh / zsh / bash，多标签页",
      "SSH 远程：基于系统 OpenSSH，支持密钥 / Agent / 密码认证",
      "串口 Serial：波特率 / 数据位 / 校验位 / 停止位 / 流控可配",
      "连接档案管理 + 5 套主题（Midnight / Daylight / Dracula / Nord / Solarized）",
      "本地 SQLite 存储，离线完全可用",
      "本地备份与恢复：导出 / 导入 JSON，支持合并（LWW）与覆盖",
      "云同步：账号登录后档案与设置多设备同步备份（自动合并冲突）",
      "安全设计：机密仅存系统密钥环，永不上传",
    ],
  },
];
