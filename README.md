# TermOne

轻量、漂亮的跨平台终端软件（Windows / macOS），参考 Tabby、WindTerm 设计。

> GitHub：https://github.com/aa24615/TermOne

- **本地终端**：PowerShell / pwsh / zsh / bash，多标签页
- **SSH 远程**：基于系统 OpenSSH，密钥 / Agent / 密码认证，known_hosts 与系统一致
- **串口 Serial**：USB-TTL 调试（波特率 / 数据位 / 校验 / 流控可配）
- **本地 SQLite**：连接档案与设置存于本地数据库，无网络也可用
- **本地备份**：一键导出/导入 JSON（档案 + 设置；合并/覆盖两种模式；不含机密）
- **云同步**：自建同步服务（REST + JWT），档案与设置多设备同步备份
- **安全设计**：SSH 密码、密钥口令等机密保存在 OS 密钥环（Windows Credential Manager / macOS Keychain），**永不上传**
- **主题**：Midnight / Daylight / Dracula / Nord / Solarized Dark

## 界面预览

| 欢迎 | 本地终端 |
| --- | --- |
| ![欢迎页](docs/screenshots/welcome.png) | ![本地终端](docs/screenshots/terminal-local.png) |
| **新建档案** | **设置** |
| ![新建档案](docs/screenshots/profile-new.png) | ![设置](docs/screenshots/settings.png) |

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

## 快速开始（桌面端）

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

## 服务端 Docker 部署

```bash
# 本地构建并启动（推荐，数据持久化在 named volume /data）
docker compose up -d --build

# 或手动构建运行
docker build -t termone-server apps/server
docker run -d -p 8787:8787 -v termone-data:/data termone-server

# 使用 CI 推送到制品库的镜像（替换仓库路径）
docker run -d -p 8787:8787 -v termone-data:/data \
  docker.cnb.cool/zyan2026/sshz/termone-server:latest
```

- 数据目录：容器内 `/data`（`TERMONE_DATA` 可改），含 `termone-server.db` 与自动生成的 `jwt.secret`
- 生产环境建议置于反向代理 + HTTPS 之后

## 发版与打包（CNB 流水线）

**客户端发版由按钮触发**：打开仓库 `main` 分支详情页 → 点击「发版 Release（客户端）」按钮 →
输入版本号（如 `0.1.0`）确认即可。流水线会自动：

1. 创建并推送 `v0.1.0` 标签
2. Windows / macOS 自托管节点打包并上传 Release 附件（Release 自动创建）

服务端镜像独立发布：点击「发布服务端镜像」按钮输入版本号，与客户端发版互不影响。

| 按钮 / 流水线 | 运行节点 | 产物 |
| --- | --- | --- |
| 发版 Release（客户端）→ `create-tag` | 云端 Linux | `v*` 标签 |
| 发版 Release（客户端）→ `desktop-windows` | 自托管 Windows（tags: `windows, x64`） | NSIS `.exe` / `.msi` → Release 附件 |
| 发版 Release（客户端）→ `desktop-macos` | 自托管 macOS（tags: `macos, arm64`） | `.dmg` → Release 附件 |
| 发布服务端镜像 → `server-image` | 云端 Linux | Docker 镜像 `v*` + `latest` |
| `check` / main push | 云端 Linux | 类型检查 + 前端构建 |

桌面端两条流水线依赖根组织自托管构建机（云端节点仅 Linux，无法打包 Win/Mac）：
按 [构建节点文档](https://docs.cnb.cool/zh/build/build-node.md) 接入后，节点需预装
Node.js ≥ 20 与 Rust 工具链（Windows 含 MSVC、macOS 含 Xcode CLT）。安装包通过
OpenAPI 三步协议（申请预签名 URL → PUT → 确认）直传 Release，脚本见
`scripts/upload-release-assets.mjs`。

## 检查与测试

```bash
npm run check                         # 前端 + 服务端 TypeScript 类型检查
cargo test -p term-core               # 核心库单元测试（存储 / LWW 合并）
```

## Web 版 SSH 远程管理（apps/web）

浏览器端的 SSH 远程管理控制台，**仅做远程 SSH**（不做本地终端 / 串口）。服务端作为 SSH 网关，
浏览器通过 WebSocket 与之通信，服务端用 `ssh2` 连接目标主机并双向透传。

```bash
npm run dev:server     # 服务端：http://127.0.0.1:8787
npm run dev:web        # Web 客户端：http://127.0.0.1:5273（已代理 /api 与 WebSocket）
```

生产模式无需单独部署前端：服务端会自动托管 `apps/web/dist`（同源，无跨域）。

```bash
npm run build --workspace @termone/web
npm run start --workspace @termone/server   # 直接访问 http://<host>:8787
```

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/ssh/hosts` | 主机列表（**仅元数据，不含凭据**） |
| POST | `/api/ssh/hosts` | 新增主机（凭据加密落盘） |
| PATCH | `/api/ssh/hosts/:id` | 编辑（凭据留空 = 保持不变） |
| DELETE | `/api/ssh/hosts/:id` | 删除主机 |
| WS | `/api/ws/ssh?token=<jwt>` | SSH 会话网关 |

WS 协议（JSON 文本帧）：

- 客户端 → 服务端：`{type:"connect", cols, rows, hostId? 或 host/port/username/authType/密码或私钥, save?}`、
  `{type:"data", data(base64)}`、`{type:"resize", cols, rows}`
- 服务端 → 客户端：`ready` / `data(base64)` / `hostkey`(指纹) / `error` / `exit`

- 客户端为每条数据维护 `updatedAt` / `dirty` / `deleted`
- **push**：`POST /api/sync/push` 上传 dirty 行；成功后按推送时的 `updatedAt` 清除 dirty
- **pull**：`GET /api/sync/pull?since=<上次游标>` 增量拉取；本地按 LWW 合并（远端更新才覆盖）
- 删除为软删除并同步到其他设备；服务端按用户隔离数据（`user_id + item_id` 主键）

## 安全边界

- SSH 复用系统 `ssh`：指纹确认、密码输入都发生在真实 PTY 内，不落地明文
- 机密仅写 OS 密钥环，SQLite 与同步数据中不含任何密码 / 口令
- 服务端密码为 bcrypt 哈希；令牌为 HS256 JWT（30 天）

### Web 版 SSH 的凭据模型（与桌面端不同，务必知悉）

**桌面端**坚持「密钥永不上传」——凭据只存 OS 密钥环，永不入库、永不上传。

**Web 版 SSH 是例外**：浏览器无法直连 SSH，必须由服务端发起连接。因此服务端需要拿到凭据：

| 模式 | 行为 | 存储 |
| --- | --- | --- |
| **保存主机**（默认） | 用户新增主机时填写凭据 | 以 **AES-256-GCM** 加密落盘（`ssh_hosts.secret_enc`），每条独立随机 IV + GCM 认证标签 |
| **临时连接** | 不勾选保存 | **不落盘**；凭据仅经 WSS 传给服务端，只存在于本次连接的内存中，连接结束即丢弃 |

缓解措施（均已实现）：

- 主密钥与数据分离：`dataDir/cred.key`（0600，首次启动自动生成），不在数据库里
- **对外接口永不返回明文**：`/api/ssh/hosts` 只返回元数据（id/名称/主机/端口/用户名/认证方式）
- 明文仅在服务端内存解密，且只用于建立 SSH 连接
- 主机公钥 **Trust-On-First-Use**（`ssh_known_hosts`）：指纹变更即拒绝连接，防中间人
- WebSocket 必须携带有效 JWT，否则以 `4401` 关闭——避免服务器沦为开放 SSH 代理
- 可用 `TERMONE_DATA` 指定数据目录，便于把 `cred.key` 放到独立的受控存储

> 若你要严格保持「服务端零知识」，请只用**临时连接**模式，或直接使用桌面端。

## Roadmap

> 2026-10-23 修订：主窗口主打**轻量实用**，SFTP、AI 辅助等增值能力**全部改为插件按需安装**。
> 详见 [`docs/需求.md`](./docs/需求.md) 与 [`docs/插件系统设计.md`](./docs/插件系统设计.md)。

**进行中（Must）**
- [ ] **插件运行时 + 插件管理（R-20）** —— 插件化战略的地基，前置项
- [ ] SFTP 图形化文件管理 **以官方插件形态交付**（后端 6 个 IPC 命令已完成，UI 待迁移为插件）

**已完成**
- [x] 分屏 Split Panes
- [x] SSH 端口转发 / JumpHost（`-L/-R/-D/-J`）
- [x] 同步端到端加密（E2EE）
- [x] 连接历史 / 最近会话
- [x] 会话日志录制（回放待插件化）
- [x] 连接分组 / 会话树
- [x] SSH 自动重连 + 心跳保活
- [x] 常用命令 Snippets（后端，UI 待插件化）

**规划（均为插件形态，按需安装）**
- [ ] 会话日志回放、广播输入、AI 命令辅助（默认关）、Quake 模式、Triggers 自动化、主题市场、Zmodem/Sixel
- [ ] 插件市场与 `.tpk` 分发
- [ ] Linux 支持（当前重点为 Windows / macOS）

**明确不做**
- 内置 SSH 协议栈（russh）—— 与「轻量」红线冲突，改为复用系统 `ssh` / `sftp`
- 移动端、内置重型 IDE 功能
