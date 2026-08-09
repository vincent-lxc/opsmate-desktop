<p align="center">
  <strong>简体中文</strong> | <a href="README.md">English</a>
</p>

<div align="center">
  <a href="https://github.com/vincent-lxc/opsmate-desktop">
    <img src="apps/desktop/src-tauri/icons/icon.png" alt="OpsMate Logo" width="112" height="112">
  </a>

  <h1>OpsMate Desktop</h1>
  <h3>OpsMate 的安全桌面入口</h3>
  <p><strong>本地凭据保险库 · 原生 SSH · 云端监控 · AI 辅助诊断 · 高风险操作确认 · 可审计发布</strong></p>
  <p>把私钥留在设备上，把监控、协作与审计连接到 OpsMate。</p>

  <p>
    <img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2">
    <img src="https://img.shields.io/badge/Rust-1.92-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust 1.92">
    <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React 19">
    <img src="https://img.shields.io/badge/macOS-Signed%20%2B%20Notarized-1f8b4c?style=flat-square&logo=apple&logoColor=white" alt="macOS signed and notarized">
    <img src="https://img.shields.io/badge/License-MPL--2.0-orange?style=flat-square" alt="MPL-2.0">
  </p>
</div>

> **权威发布源：** 本仓库的 `apps/admin` 与 `apps/desktop`。根目录 `src` 与 `src-tauri` 仅保留历史代码，不参与正式构建和发布。

OpsMate Desktop 是 [OpsMate](https://github.com/vincent-lxc/ops-ai) 的独立桌面客户端。它把登录会话、云端传输、本地凭据保险库和本地 Secure Shell（SSH）连接放在 Rust 可信边界内。React WebView 负责界面呈现，不持有访问令牌、刷新令牌、SSH 私钥或口令。

## 目录

[产品定位](#产品定位) · [当前能力](#当前能力) · [安全与信任边界](#安全与信任边界) · [凭据托管模型](#凭据托管模型) · [高风险操作](#高风险操作) · [可审计性](#可审计性) · [架构](#架构) · [下载与发布状态](#下载与发布状态) · [本地开发](#本地开发) · [仓库结构](#仓库结构) · [安全报告](#安全报告) · [许可证](#许可证)

## 产品定位

OpsMate Desktop 不是 OpsMate SaaS 后端的离线副本，也不是通用终端。它为需要管理 SSH 服务器的个人和团队提供受控的桌面执行环境，同时复用 OpsMate 的账号、服务器、监控、订阅与 AI 服务。

| 你关心的 | Desktop 的处理方式 |
|----------|--------------------|
| 私钥不应进入浏览器 | 私钥和口令由 Rust 本地保险库读取，React 不接触明文 |
| 本地 SSH 需要可信主机校验 | Rust 执行连接与主机密钥校验，首次信任通过原生窗口确认 |
| 无人值守巡检需要云端凭据 | 只有你明确选择云端托管后，OpsMate 才能执行无人值守任务 |
| 高风险操作不能误触 | 页面警告与原生二次确认共同保护上传、删除和保险库重置 |
| 客户端需要可审计 | IPC、云端 API、生成代码、测试与发布流程均有可检查的源文件和门禁 |

## 当前能力

Desktop 以四个一级入口组织日常操作：

| 入口 | 能力 |
|------|------|
| **监控中心** | 查看 OpsMate 云端监控数据、巡检结果与问题状态 |
| **我的服务器** | 查看服务器详情，并从详情页进入 SSH 终端与 AI 工作区 |
| **凭证** | 管理本地保险库和明确选择的云端托管凭据 |
| **我的账户** | 查看账号、Telegram 绑定、版本权益与订阅状态 |

SSH 终端与 AI 工作区属于服务器详情上下文，不提供独立的一级终端菜单。账号可见菜单与操作权限由 OpsMate SaaS 返回的角色和权益决定，后端 API 门禁始终是最终授权依据。

### 登录与会话

登录流程通过系统浏览器完成 Logto Proof Key for Code Exchange（PKCE）认证，并通过 `opsmate://auth/callback` 返回应用。Rust 保存并刷新会话，向固定云端请求注入授权信息。

发生退出、身份切换、系统锁定、休眠或云端返回 `401` 时，客户端执行安全截止流程：

1. 取消对应身份周期内的云端请求
2. 清除本地会话
3. 关闭本地与云端终端连接
4. 锁定本地保险库

### SSH 与 AI

本地 SSH 连接由 Rust 建立。客户端检查主机密钥，并把已确认的主机记录写入本地 `known_hosts` 边界。React 只能发送命名后的终端操作，不能调用通用 shell。

当你把终端片段发送给 OpsMate AI 时，Rust 会先处理敏感字段、常见凭据模式和输出长度限制。该控制降低意外上传风险，但不能替代你对发送内容的检查。

## 安全与信任边界

Desktop 把 WebView 视为半可信界面，把 Rust 主进程视为本地高信任执行边界。

| 区域 | 信任级别 | 负责内容 |
|------|----------|----------|
| React WebView | 半可信 | 路由、表单、列表与展示状态 |
| Rust / Tauri | 高信任 | PKCE、会话令牌、本地保险库、SSH、云端 HTTP/WebSocket、原生确认 |
| OpsMate SaaS | 云端服务边界 | 账号、服务器、监控、订阅、AI、审批与云端审计 |
| Logto | 外部身份提供方 | 系统浏览器中的登录与授权 |

客户端遵守以下硬性规则：

- React 和 WebView 不接收 OpsMate 访问令牌或刷新令牌
- SSH 私钥与口令不进入 React state、Web Storage 或应用日志
- WebView 不具备通用 shell、通用 opener 或任意 URL 请求代理
- 云端请求仅允许 `https://app.itops.sh` 与 `wss://app.itops.sh`
- 每个云端操作必须出现在签入仓库的操作清单中
- 本地凭据默认留在设备上，上传云端必须由你明确触发
- 安全校验失败时操作终止，不降级绕过

完整边界与攻击面见 [`THREAT_MODEL.md`](THREAT_MODEL.md)。

## 凭据托管模型

本地与云端凭据解决不同问题。Desktop 不会把本地私钥自动同步到云端。

| 模式 | 保存位置 | 适用场景 | 无人值守巡检 |
|------|----------|----------|----------------|
| **本地保险库** | 当前设备的 Stronghold 加密保险库 | 人在设备前发起 SSH 与诊断 | 不支持 |
| **云端托管** | OpsMate SaaS 的受控凭据服务 | 定时巡检、告警处理与远程协作 | 支持 |

本地保险库按已验证的账号主体、租户和凭据标识隔离。锁定保险库会清除内存中的解锁状态，但不会删除保险库文件。

云端托管是独立的信任选择。上传前请确认凭据范围、服务器权限和无人值守用途。生产服务器优先使用最小权限账号，并限制可执行命令。

## 高风险操作

Desktop 对改变凭据托管或销毁本地数据的操作使用分层确认。

| 操作 | 页面确认 | 原生确认 | 结果 |
|------|----------|----------|------|
| 上传凭据到云端 | 明确说明托管变化 | 需要 | 云端可用于无人值守任务 |
| 删除云端凭据 | 明确说明影响范围 | 需要 | 相关云端任务可能无法连接 |
| 删除本地凭据 | 明确说明本机影响 | 按操作策略执行 | 仅删除当前设备副本 |
| 重置本地保险库 | 不可恢复警告 | 确认短语与勾选确认 | 关闭终端并删除本地保险库与盐值 |

“重置本地保险库”不会删除云端托管副本。只存在于本地保险库中的凭据无法恢复。客户端不会在后台自动执行该操作。

## 可审计性

可审计性覆盖源码边界、运行时决策和发布证据。Desktop 不伪造第二套本地业务审计账本，云端业务操作的审计记录由 OpsMate SaaS 负责。

| 审计面 | 可检查证据 | 约束 |
|--------|------------|------|
| WebView IPC | [`desktop-ipc.toml`](apps/desktop/src-tauri/permissions/desktop-ipc.toml) | 只允许命名命令，不允许通用 shell 或 opener |
| 云端 API | [`desktop-operations.json`](contracts/desktop-operations.json) | 单一操作清单生成 Rust、TypeScript 与 OpenAPI 契约 |
| 契约漂移 | `npm run contracts:check` | 生成文件与清单不一致时构建失败 |
| 高风险决策 | 页面警告、原生窗口、确认短语 | WebView 单次点击不能完成关键销毁操作 |
| 会话失效 | Rust 安全截止流程与测试 | `401`、退出或身份切换时关闭会话、终端和保险库 |
| AI 出站内容 | Rust 脱敏与长度限制测试 | 异常载荷失败关闭，不直接转发 |
| 发布产物 | [桌面发布工作流](.github/workflows/desktop-release.yml) | 测试、Clippy、签名、公证、Gatekeeper 与摘要门禁 |

云端凭据、审批和处置操作是否出现在业务审计日志中，以 SaaS API 的当前实现和账号权益为准。本仓库只声明客户端能够证明的控制，不把界面可见性等同于服务端授权或审计完成。

## 架构

Desktop 把展示层和高信任执行层分开。所有敏感操作通过命名后的 Tauri IPC 进入 Rust。

```text
System browser
    │ Logto PKCE
    ▼
Rust / Tauri host
    ├── session and token custody
    ├── Stronghold local vault
    ├── local SSH transport
    ├── fixed-origin cloud transport
    └── native confirmation
             ▲
             │ named IPC only
             ▼
React WebView
    └── monitoring, servers, credentials, account
```

| 组件 | 技术与职责 |
|------|------------|
| Admin UI | React 19、TypeScript 5、Vite 6、Ant Design |
| Desktop host | Tauri 2、Rust 1.92、Stronghold、本地 SSH |
| Cloud transport | Rust HTTP/WebSocket 客户端、固定域名与操作白名单 |
| Identity | 系统浏览器 Logto PKCE、Deep Link 回调 |
| Tests | Vitest、Rust tests、契约生成检查、Capability 边界测试 |

本仓库是独立 Git 项目，不嵌入 `ops-ai/apps/admin` 或 `../../admin/dist`。正式前端从本仓库 `apps/admin` 构建，Tauri 从生成的 `apps/admin/dist` 加载资源。

## 下载与发布状态

macOS 预发布版本通过 [GitHub Releases](https://github.com/vincent-lxc/opsmate-desktop/releases) 提供。发布流水线构建 Apple Silicon 与 Intel 通用 DMG，并执行以下门禁：

1. 安装锁定依赖并运行前端测试
2. 检查生成契约与源清单一致
3. 构建 Web 前端
4. 运行 Rust 格式检查、严格 Clippy 与测试
5. 使用 Developer ID 签名通用 macOS 应用
6. 提交 Apple 公证并装订公证票据
7. 执行 `codesign`、Gatekeeper 和 stapler 验证
8. 发布 DMG 与 SHA-256 摘要

所有 `desktop-v*` Release 当前均属于预发布渠道。macOS 已提供签名与公证产物；Windows 和 Linux 公共安装包尚未发布。项目尚未承诺长期支持版本或正式通用可用（GA）渠道。

## 本地开发

本地开发需要 Node.js 22.22.0 或更高版本，以及 Rust 1.92.0。

安装依赖并运行前端测试：

```bash
npm ci
npm test
npm run contracts:check
npm run build:web
```

运行 Rust 质量门禁：

```bash
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml \
  --all-targets --all-features -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml \
  --all-targets -- --test-threads=1
```

启动 Tauri 开发应用：

```bash
npm run dev:tauri
```

构建当前平台安装产物：

```bash
npm run build
```

## 仓库结构

```text
apps/
  admin/                 React 桌面界面与 Desktop bridge
  desktop/               Tauri 应用、Rust 主进程与平台资源
contracts/
  desktop-operations.json  云端操作单一事实源
scripts/
  generate-operations.mjs  契约生成与漂移检查
  desktop-build-admin-dist.sh
.github/workflows/
  desktop-ci.yml
  desktop-release.yml
SECURITY.md
THREAT_MODEL.md
```

## 安全报告

请通过 GitHub Private Vulnerability Reporting 或本仓库的私有 Security Advisory 报告漏洞。不要在公开 Issue 中发布漏洞细节、凭据或客户数据。

报告应包含：

1. 受影响的版本、标签或提交
2. 影响范围
3. 可重复的验证步骤
4. 是否涉及凭据或客户数据

完整流程见 [`SECURITY.md`](SECURITY.md)。

## 许可证

OpsMate Desktop 使用 [Mozilla Public License 2.0](LICENSE)，SPDX 标识为 `MPL-2.0`。

<div align="center">

**OpsMate Desktop**: Keep credentials local, keep critical actions human-controlled, keep releases auditable.

</div>
