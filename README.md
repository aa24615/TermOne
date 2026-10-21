# TermOne

轻量、漂亮的跨平台终端软件（Windows / macOS），参考 Tabby、WindTerm 设计。

- **本地终端**：PowerShell / pwsh / zsh / bash，多标签页
- **SSH 远程**：基于系统 OpenSSH，密钥 / Agent / 密码认证，known_hosts 与系统一致
- **串口 Serial**：USB-TTL 调试（波特率 / 数据位 / 校验 / 流控可配）
- **本地 SQLite**：连接档案与设置存于本地数据库，无网络也可用
- **云同步**：自建同步服务（REST + JWT），档案与设置多设备同步备份
- **安全设计**：SSH 密码、密钥口令等机密保存在 OS 密钥环（Windows Credential Manager / macOS Keychain），**永不上传**
- **主题**：Midnight / Daylight / Dracula / Nord / Solarized Dark

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Tauri 2（Rust） |
| 终端核心 | `crates/term-core`：portable-pty（本地/SSH）、serialport（串口）、rusqlite（存储）、keyring（机密） |
| 前端 | React 18 + TypeScript + Zustand + xterm.js |
| 服务端 | Node.js + Fastify + JWT + node:sqlite（零原生依赖） |
| 同步协议 | 增量 pull / push，按 `updatedAt` 最后写入胜出（LWW），支持删除传播 |

## 目录结构

```
├── apps/desktop          # 桌面应用（Tauri + React）
│   ├── src               #   前端源码
│   └── src-tauri         #   Rust 壳（commands / 事件 / 窗口）
├── apps/server           # 同步服务端（Fastify + JWT + SQLite）
├── crates/term-core      # 核心库：会话 / 存储 / 密钥环（可独立测试）
├── docs/需求.md           # 需求记录
└── tools/gen_icons.py    # 图标生成脚本（纯标准库）
```

## 快速开始

依赖：Node.js ≥ 23.4（服务端使用内置 `node:sqlite`）、Rust ≥ 1.77；Windows 需 MSVC 工具链与 WebView2，macOS 需 Xcode Command Line Tools。

```bash
# 1) 安装依赖（npm workspaces）
npm install

# 2) 开发模式运行桌面端（首次会编译 Rust，需要较长时间）
cd apps/desktop
npm run tauri dev

# 3) 构建发布包（Windows 生成 msi/nsis，macOS 生成 app/dmg）
npm run tauri build
```

启动同步服务端（可选，用于账号与云同步）：

```bash
# 开发
npm run dev:server           # 默认 http://0.0.0.0:8787

# 生产
PORT=8787 HOST=0.0.0.0 npm start --workspace @termone/server
```

- 数据目录：`TERMONE_DATA`（默认 `./data`），含 `termone-server.db` 与自动生成的 `jwt.secret`
- JWT 密钥首次启动自动生成，重启后令牌仍然有效；生产环境建议置于反向代理 + HTTPS 之后
- 桌面端「设置 → 服务器地址」填入服务端地址（默认 `http://127.0.0.1:8787`），注册 / 登录后自动双向同步

## 检查与测试

```bash
npm run check                         # 前端 + 服务端 TypeScript 类型检查
cargo test -p term-core               # 核心库单元测试（存储 / LWW 合并）
```

## 同步协议（概要）

- 客户端为每条数据维护 `updatedAt` / `dirty` / `deleted`
- **push**：`POST /api/sync/push` 上传 dirty 行；成功后按推送时的 `updatedAt` 清除 dirty
- **pull**：`GET /api/sync/pull?since=<上次游标>` 增量拉取；本地按 LWW 合并（远端更新才覆盖）
- 删除为软删除并同步到其他设备；服务端按用户隔离数据（`user_id + item_id` 主键）

## 安全边界

- SSH 复用系统 `ssh`：指纹确认、密码输入都发生在真实 PTY 内，不落地明文
- 机密仅写 OS 密钥环，SQLite 与同步数据中不含任何密码 / 口令
- 服务端密码为 bcrypt 哈希；令牌为 HS256 JWT（30 天）

## Roadmap

- [ ] 内置 SSH 协议栈（russh）+ SFTP 图形化文件管理
- [ ] 分屏、会话回放、连接历史
- [ ] 主题市场与插件系统
- [ ] 同步端到端加密（E2EE）
- [ ] Linux 支持（当前重点为 Windows / macOS）
