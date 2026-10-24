# TermOne 需求实现与验证记录

> 更新：2026-10-24。依据 `需求.md`、`竞品分析与需求规划.md`、`插件系统设计.md`。记录本期实际交付及证据边界。

## 本期代码完成

- **R-20 插件运行时/管理**：安装、默认停用、启用、懒激活、停用、更新、卸载；9 项官方目录；本地 `.tpk`/目录导入、开发目录热加载、自托管 HTTPS registry 与 SHA-256；声明式第三方 UI、隔离 Worker、贡献点/命令面板/设置/状态栏、权限与审计。同步只携带元数据，本机授权独立。
- **R-01 SFTP 插件化**：移除主窗口 FileManager；双栏、文件操作、双向拖拽、队列/失败重试；核心按 profileId 取凭据。文件选择授权限定本地路径，下载和上传采用临时文件后替换。
- **R-02 分组**：嵌套分组新建/改名/删除/折叠、档案跨组拖动与排序、分组拖动防环、跨组搜索高亮、ProfileDialog 分组选择，同步与备份沿用核心表。
- **R-03 分屏**：空面板内打开终端/档案、独立会话、保存/恢复布局；只保存结构和档案引用，不持久化会话 ID/凭据。
- **R-04 自动重连**：接入会话 EOF/退出事件，SSH 传输失败（255/无退出码）才重试，默认 5 秒、有限指数退避、60 秒上限、手动重连/停止，关闭设置会取消排队重试；SSH 心跳 30 秒、3 次失败上限。稳定 30 秒后清零重试计数。重连建立新 shell，不承诺恢复失联远端进程/目录。
- **R-05 E2EE**：锁定和错误口令均禁止导出、推送、应用拉取、推进游标；先解密拉取再推送。启用/解锁重新拉取，切换策略重新排队全部同步记录。加密开关是本机安全策略，远端同步不能关闭它。
- **R-06/R-10 转发/跳板**：保留档案与 `-L/-R/-D/-J`；本期回归编译。SSH 关闭本地 escape，避免远端输入触发本地子进程。
- **R-07 Snippets**：插件新增/修改/删除/选择会话/确认执行，变更参与自动同步。
- **R-08 日志**：录制开关留核心；真实会话 UUID 命名；插件列表、搜索、回放和导出。
- **R-09 最近会话**：连接时 touch，欢迎页加载最近 10 项，点击重连。
- **R-11 主题市场**：精选离线主题、JSON 导入、自托管 HTTPS 主题索引；核心基础设置保留 JSON 导入。
- **R-12 AI 辅助**：默认未安装/未启用，兼容 Chat Completions；地址/模型/Key 用户自填，Key 仅面板内存；手动问题发送前确认，不读终端、不执行结果。
- **R-13 Quake**：可配置原生全局快捷键呼出/隐藏；停用注销。
- **R-14 广播**：选择活动会话、预览并确认内容、可选追加回车。
- **R-15 Zmodem/Sixel**：可撤销终端适配器、协议检测/确认/发送/接收/中止，单文件 64 MiB；Sixel 图像存储 16 MiB。
- **R-16 Linux**：GTK/WebKit/系统依赖脚本、可复用 ARM64 构建镜像、DEB/RPM/AppImage，CNB Linux 发版任务和附件上传。Linux/Windows 使用自绘标题栏；Linux 密钥环接入 Secret Service。
- **R-17 Triggers**：连接/输出文字匹配，通知或固定命令，冷却/每会话单次，命令动作须确认布防。
- **R-21 Web SSH**：保持原有共享主机库、凭据默认不上云、JWT/TOFU/E2EE 降级；本期运行既有两组服务端冒烟。

**R-26 命令安全分类器（核心逻辑）**：新增 `crates/term-core/src/safety.rs`，纯逻辑、零依赖实现 `classify_command`——多行粘贴检测（按换行计有效语句数）+ 危险命令识别（递归删除 `rm -r/-R`、分区工具 `mkfs/fdisk/parted`、直接写盘 `dd`、fork 炸弹、设备重定向 `> /dev/`、关机 `shutdown/reboot/halt/init`、下载喂 shell `curl|sh`、破坏性 `git reset --hard/clean/push --force`、权限清零递归 `chmod 0.../-R`），区分 `Safe/Caution/Danger` 三级与 10 类 `RiskReason`，去注释与引号字面量防误报；**31 项 P0–P5 单元测试**覆盖正常路径、核心危险、边界、组合前缀、防误报与极端回归。UI 接线（粘贴拦截调用分类器弹二次确认）待补。

**R-18 移动端、R-19 重型 IDE 按需求 Won’t 保留不做。**

## 自动化证据

- `cargo test --workspace --release --locked`：**83 项 term-core + 4 项原生命令测试通过**（本期新增 R-26 安全分类器 31 项 P0–P5 用例）。涵盖存储/LWW/备份、分组/最近/Snippets、重连策略、命令安全分类（多行粘贴 + 危险命令）、manifest/ZIP 路径/权限/密钥环拒绝、官方 catalog、目录 symlink 拒绝、E2EE 本机策略不被同步覆盖。
- `npm run check`：桌面端、服务端、Web 三个工作区 TypeScript 通过。
- `npm run test:desktop`：**14 项通过**。真实 Web Crypto 随机化、中文、错误口令、篡改；锁定/解密失败不推送不推进游标；密文同步；ZIP/HTTPS/digest；资源撤销与确认框取消；第三方本地写入拒绝；重连次数；布局不含会话 ID；拉取期间切换账号不应用/不推送原账号数据；正常退出不重连、传输失败可停止；欢迎页分屏可保存。
- `node tools/zmodem-smoke.mjs`：**1 MiB 全字节二进制 offer/accept/send/receive/close 回环及内容一致性通过**。据此修复库 `accept()` 返回值使用错误。
- `node tools/sftp-smoke.mjs`：本机 SSH2 SFTP fixture，**52 MiB 上传/列表；下载中断保留旧文件并清除 `.part`；重试字节一致；上传中断保留远端旧文件；上传重试；换行注入拒绝通过**。fixture 使用临时身份/known_hosts，不改用户 SSH 配置。
- `node tools/ssh_cred_smoke.mjs`：**13/13**；`node tools/ssh_shared_smoke.mjs`：**22/22**。使用独立临时数据运行本地服务，测试结束清理。
- 桌面 Vite 产物：SFTP、Zmodem、AI 等实现均为独立动态 chunk，插件管理/第三方沙箱独立 chunk。主 JS 约 552 KB；大小不是冷启动/RSS 量测。

## macOS 真机界面证据

使用独立 `TermOneQA.app` 与 `TERMONE_DATA_DIR`，不改 `/Applications/TermOne.app` 或正式应用数据。

已交互验证：零插件无 SFTP 入口；官方 SFTP 安装仍默认停用；启用后入口与面板出现；系统文件选择器导入 `.tpk`；第三方 Hello Worker UI 和按钮通知；权限探针拒绝密钥环、未声明存储、越权网络及直接网络；Worker 无 DOM/Tauri；插件异常显示错误占位，主窗口可继续新建本地 zsh；左右分屏后新终端在空面板内打开；中文嵌套分组创建；Zmodem/Sixel 激活且真实终端渲染 Sixel 红色图块；第三方更新重新确认权限并恢复停用；已声明 local_list 但未选择路径时，原生文件系统权限仍拒绝；系统选择独立测试目录后只能读取授权目录，成功返回 1 项。

## 构建与验收限制

- macOS Apple Silicon：本机 release app/DMG 构建；应用使用 ad-hoc 签名，未 Apple 公证。产物位于仓库根 `target/release/bundle`。
- Linux ARM64：Debian 12 容器 release 构建 DEB/RPM/AppImage、56 项 Rust 与 14 项前端测试通过；DEB 实际安装，DEB/AppImage 在独立数据目录的 Xvfb 图形环境下分别持续存活 12/15 秒并创建数据库。容器以 root 运行时仅对测试进程设置 WebKit sandbox 环境变量，不作为用户安装建议；容器验证不等于所有 Linux 桌面实机验证。
- **尚未完成的验收证据**：零插件冷启动/RSS 与无插件基线 ≤5% 的严格量测、四分屏内存预算、Windows 实机/安装包回归、Linux x64/Wayland/多桌面、真实 AI 服务/Key、真实远端 Zmodem/Sixel 互通、真实外部网络弱网/转发/串口硬件。以上不能用编译或协议回环结果替代。
- 自托管 registry 客户端已实现，未部署公共市场服务；没有虚构公共下载地址。内置插件版本随应用交付。
- SFTP 重试会重新传整个文件；失败上传可能留下远端 `.part`，原目标不会被半文件覆盖。日志读取上限 8 MiB、列表上限 500。
- Linux Secret Service 需要桌面 keyring 服务；无该服务的 headless 容器只验证无凭据启动，不代表密钥环成功。

此前文档中的 Windows SAC 构建限制属于历史环境；当前 macOS / Linux 构建证据已单列，不再沿用“后端未编译”的过时结论。
