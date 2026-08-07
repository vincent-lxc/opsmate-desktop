# OpsMate Desktop 复用 Web UI 与安全原生运行时设计

## 目标

修复当前已发布桌面端只有占位页面的问题，交付真正可用的 macOS 客户端。桌面端完整复用主仓 `apps/admin` 的现有界面和交互，不再设计、维护第二套 React 产品页面；`apps/desktop` 提供 Tauri 容器与安全原生适配层。

完成后的桌面端必须支持现有 Web 用户界面中的服务器、监控、凭证、账户、订阅和 Telegram 功能，并支持服务器详情中的原生 SSH 终端与 AI 助手。用户可见数据继续由后端租户鉴权和数据库 RLS 隔离。

## 当前问题

主仓与发布仓存在两套互不一致的桌面实现：

- 主仓 `apps/desktop` 已配置为构建并加载 `apps/admin/dist`，具备完整 Web UI。
- 独立 `opsmate-desktop` 仓库拥有更严格的 Rust 认证、云端传输、Stronghold、SSH 和发布能力，但其 React 层只有监控、服务器、凭证和账户占位页面。
- `desktop-v0.1.3` 正确签名并公证了独立仓产物，但没有功能验收门禁，因此把未完成的 foundation shell 发布给了用户。

签名、公证和 Gatekeeper 通过只能证明产物来源与完整性，不能证明产品功能可用。

## 产品决策

### 唯一 UI

`apps/admin` 是 Web 与 Desktop 的唯一产品 UI 权威。Desktop 不再创建自己的监控页、服务器页、凭证页或账户页，也不重新设计这些页面。

服务器列表、分组、搜索、添加服务器、服务器详情、资源概览、监控清单、依赖关系和 SSH 终端均沿用 Web 端界面。浏览器与桌面端的视觉、文案和主要交互保持一致。

### 唯一桌面产品源

主仓 `apps/desktop` 是桌面应用的产品源。独立 `opsmate-desktop` 不再拥有另一套产品 UI；其职责收敛为公开发布编排和历史发布承载。独立仓已经验证的安全实现应经过差异审查后合并进主仓 `apps/desktop`，不能同时维护两份分叉的安全内核。

### 桌面安全适配而非远程页面

桌面应用加载本地构建的 `apps/admin/dist`，不把 `https://app.itops.sh` 远程页面直接放进拥有 Tauri IPC 权限的 WebView。远程页面不能获得 vault、SSH、文件选择、外部导航或其他桌面能力。

浏览器继续使用现有 HTTP/WebSocket 实现。相同的 Admin UI 在 Tauri 环境中通过桌面适配器调用 Rust；页面组件不直接持有 JWT、私钥、口令、任意 API origin、SSH host 或 SSH username。

## 架构

```text
apps/admin React UI
        |
        | Browser: existing fetch / WebSocket
        | Desktop: typed desktop adapter
        v
apps/desktop Rust runtime
  - Logto PKCE and session
  - allowlisted cloud HTTP / WebSocket
  - Stronghold credential vault
  - native SSH session actor
  - safe external navigation
        |
        +---- HTTPS ----> app.itops.sh
        |
        +---- SSH ------> tenant-owned target server
```

### Admin 适配层

在 `apps/admin` 建立一个集中式运行时适配边界，避免每个页面分别判断 Tauri：

- `api()` 保持现有调用签名；浏览器使用当前 fetch，桌面使用 Rust cloud IPC。
- 认证入口保持现有 UI；浏览器走当前登录流程，桌面调用 Rust Logto PKCE 与 deep-link。
- `useServerTerminal` 保持现有组件接口；浏览器使用云端 WebSocket，桌面优先使用 Rust 本地 SSH。
- 凭证页面保持现有元数据布局；桌面密钥导入、口令、上传和删除确认调用原生命令。
- 账户和订阅页面保持现有组件；桌面外链调用固定目标的原生 opener。

适配器只能在构建时或受控的 Tauri runtime 检测后选择实现。业务组件不得直接导入散落的 Tauri API。

### 云端请求代理

Desktop WebView 的 CSP 禁止直接连接公网。Rust 持有 OpsMate JWT，并执行所有云端 HTTP 与 WebSocket 请求。

请求代理采用生成的 method + path-template allowlist：

- allowlist 来自 Desktop 实际启用的 Admin API 契约；不能接受任意 origin、完整 URL 或任意 header。
- 动态资源 ID 按类型和长度校验；拒绝 `..`、编码斜杠、查询拼接和 path smuggling。
- Rust 固定 API origin 为 `https://app.itops.sh`，并原生添加当前会话 JWT。
- 响应大小、超时、取消和并发均有上限。
- 401 或会话切换触发统一 security cutoff：停止云端请求、关闭 SSH、密封 vault 并返回固定公开错误码。
- WebView 只能看到现有页面所需的业务 JSON；不得看到 token、Set-Cookie、上游响应头或原始传输错误。

后端仍是权限权威。Rust allowlist 缩小客户端攻击面，但不替代后端角色、租户检查和 RLS。

### 用户与服务器隔离

Desktop 不接收或自选 tenant ID。Rust 从经过验证的 Logto/OpsMate 会话获得 subject、tenant 和 workspace 绑定，所有请求使用该会话。

服务器列表与详情必须沿用后端隔离语义：

- 只能返回当前租户拥有的服务器。
- 跨租户服务器 ID 返回 404 等价响应，不暴露名称、IP、描述、凭证或存在性。
- Desktop 前端过滤不算隔离证据；发布门禁必须包含后端 A/B 租户测试。

## 认证和会话

- Desktop 使用系统浏览器启动 Logto PKCE。
- Logto redirect 固定为 `https://app.itops.sh/login/desktop/callback`，Admin bridge 再转发至 `opsmate://auth/callback`。
- PKCE verifier、state、OpsMate JWT、refresh/session material 只存在 Rust 内存或受控原生存储中。
- WebView 仅接收 `authenticated`、用户公开资料、租户/工作区显示信息和固定公开错误码。
- 登出、账户切换、租户切换、系统睡眠、屏幕锁定和进程退出都先关闭 SSH，再清空授权并密封 Stronghold。

## 凭证与 Stronghold

凭证页使用 Web 端布局，但在 Desktop 中展示本机与云端两维状态：

- 云端元数据：名称、类型、指纹、绑定服务器数量、是否有云端托管副本。
- 本机状态：vault 是否初始化/解锁、此设备是否存在对应密钥。

安全规则：

- 新 SSH 私钥默认只导入本机 Stronghold。
- 文件选择、粘贴、PEM 解析和 passphrase 输入使用原生窗口；React 只传 `credentialId`。
- React 永远不能读取 PEM、passphrase、Stronghold snapshot path 或解密后的密钥。
- 主动上传云端副本时，Rust 显示原生确认，读取 Stronghold lease，经 HTTPS 发送到后端加密落库，然后立即清除明文缓冲。
- 删除云端副本与删除本机副本是两个独立操作，均明确显示影响。删除本机副本前先关闭使用该凭证的本地 SSH 会话。
- 服务器绑定只传已经鉴权的 `serverId` 与 `credentialId`；Rust 和后端共同校验它们属于当前租户。

## SSH 终端

Web 端服务器详情中的“SSH 终端”标签继续使用现有 xterm UI。Desktop 运行时改用 Rust 原生 SSH：

- `local_ssh_open` 只接受 `serverId` 与 `credentialId`。
- Rust 在线读取当前租户可见的服务器元数据并验证服务器绑定凭证；WebView 不能提供 host、port 或 username。
- 此设备存在本机密钥时优先使用 Stronghold 本地 SSH。
- 本机密钥缺失但云端存在托管密钥时，可由 Rust 代理现有云端终端 WebSocket；WebView 不直接连接公网。
- 终端 IPC 只暴露不透明 `sessionId`、输入字节、输出字节、resize 和 close。
- host key 首次信任或变化必须使用原生确认；变化不能静默接受。
- vault 锁定、会话失效、睡眠、退出和凭证删除都会终止相关会话；关闭后写入必须失败。

## AI 助手

AI 助手完整复用 Web 端 `TerminalAiChat` 界面和行为。用户在已经打开的交互式 SSH 会话中发送请求后，AI 可以生成命令，Desktop 自动通过同一原生 SSH 会话执行、读取输出并继续分析，最多三轮。

约束：

- 发送 AI 请求是本次交互式自动执行的用户授权；不增加逐命令确认。
- 每轮界面必须显示将执行或正在执行的命令、轮次和运行状态。
- 任一命令失败、会话关闭、vault 锁定、AI 额度不足或请求取消时立即停止后续轮次。
- Rust 对发送给云端 AI 的终端片段执行长度限制和敏感内容脱敏；不得发送 PEM、passphrase、token 或完整长期终端历史。
- AI 命令执行沿用现有审计记录，但审计不得存储密钥、token 或完整终端输出。
- 此能力只在用户主动打开的桌面终端会话内运行，不创建后台常驻本地 Agent，也不扩大无人值守权限。

## 账户、Telegram 与订阅

账户页直接复用 Web 端 `Account` 和 `AccountSubscriptionPanel`：

- 展示公开身份、租户/工作区、Telegram 绑定状态、当前方案、订阅状态和 AI 额度。
- Telegram 绑定开始、轮询和解绑通过 Rust 云端代理调用现有 API。
- “订阅”“继续支付”“管理订阅”根据服务端真实订阅状态显示，不能把非 active 的首次订阅错误地变成只有“管理订阅”。
- Desktop 不能传入任意 URL。Rust 只接受固定 route ID，并映射至 `https://app.itops.sh` 的登录、checkout 或订阅管理路径后使用系统浏览器打开。

## 错误处理

Rust 将内部错误映射为固定公开代码，Admin 适配层再映射为现有本地化提示。日志、UI 和错误对象均不得回显 URL、JWT、PEM、passphrase、SSH 原始握手细节或上游响应体。

必须覆盖以下用户状态：

- 未登录或会话失效：返回登录页，并执行完整 security cutoff。
- 云端不可达：页面保留重试；本地 SSH 新建连接因无法验证服务器元数据而阻断。
- vault 未初始化或已锁定：引导初始化/解锁，不能假装凭证可用。
- 本机无密钥但云端有副本：明确显示并允许安全云端终端路径。
- 本机和云端均无密钥：阻断 SSH，并引导导入或选择其他凭证。
- AI 额度不足：终端仍可用，AI 面板显示购买入口。
- 跨租户或资源不可见：显示统一未找到，不推断资源存在。

## 发布架构

公开下载仍由 `vincent-lxc/opsmate-desktop` GitHub Releases 承载，以保持现有下载链接和签名环境。该仓的 release workflow 改为发布编排器：

1. 使用只读、细粒度的 source token 检出 `vincent-lxc/opsmate` 的明确 commit。
2. 构建该 commit 的 `apps/admin` 与 `apps/desktop`，禁止构建独立仓占位 UI。
3. 运行 Admin、Desktop Rust、契约与安全门禁。
4. 构建 macOS Universal DMG，执行 Developer ID 签名、Apple 公证、staple、codesign、Gatekeeper 和 stapler 验证。
5. Release notes 和校验文件记录主仓 source commit，保证产物可追溯。

Windows 继续禁用，不进入本次修复。Linux 可继续保留，但 macOS 是本次发布阻断平台。

## 测试与发布门禁

实现采用测试驱动开发。每项行为先增加失败测试，再实现最小代码使其通过。

### 自动化

- Admin：浏览器 transport 不回归；Tauri transport 使用 Rust IPC；页面不直接调用公网或散落的 Tauri API。
- 认证：PKCE、state、deep-link、会话切换和公开错误码。
- 云端代理：method/path allowlist、路径走私、响应上限、超时、401 cutoff 和秘密不外泄。
- 凭证：初始化、解锁、导入、列表、上传、双重删除语义、租户/subject 隔离和生命周期密封。
- SSH：服务器/凭证绑定、host key、打开、输入、输出、resize、关闭、锁库终止和关闭后拒写。
- AI：最多三轮、失败停止、取消停止、额度错误、输出脱敏和审计摘要。
- 后端：A/B 租户服务器与凭证隔离，跨租户 404 等价，终端 AI 不加载或返回 SSH 私钥。
- Release：必须构建主仓 `apps/desktop`，并拒绝含 placeholder 文案或独立 React shell 的产物。

### macOS 人工 UAT

发布前必须在签名、公证后的 DMG 上完成：

1. 全新安装并通过 Gatekeeper 启动。
2. Logto 交互式登录成功。
3. 当前用户只能看到自己的服务器。
4. Web 端服务器列表、详情、监控、凭证和账户页面正常显示。
5. 初始化/解锁 Stronghold，导入本机 SSH 私钥且 React/日志无秘密。
6. 打开真实 UAT 服务器，完成交互输入、输出、resize 和关闭。
7. AI 自动执行命令、读取输出并在三轮内给出结论。
8. 锁库或系统睡眠后 SSH 会话立即失效。
9. 订阅状态、继续支付/管理订阅、AI 额度和 Telegram 状态正确。
10. 退出并重新打开后，私钥仍受 Stronghold 保护，JWT 不出现在 WebView storage。

任何一项 NOT RUN、BLOCKED 或 FAIL 都不能宣称桌面端可用，也不能更新官网为正式推荐下载。

## 不在本次范围

- 重新设计 Web 或 Desktop 页面。
- 维护独立 Desktop React UI。
- Windows 构建和签名恢复。
- 后台常驻本地 Agent。
- 离线缓存服务器连接参数。
- 绕过后端租户鉴权、角色权限、订阅权益或 RLS。

## 结果

用户在 macOS Desktop 中看到与 Web 端一致的成熟界面，同时获得本机 Stronghold、原生 SSH 和 Rust 托管会话的安全能力。发布门禁从“产物能签名和安装”升级为“真实登录、租户隔离、凭证、终端、AI 和账户闭环全部通过”。

