# Publisher Worker（e宝工坊内置模式）

Worker 源码从 `feat/ebao-publisher-worker` 固定提交派生；文章扩展在 `codex/ebao-article-adapters` 开发。它不启动 MatrixMedia Vue 主窗口，只供 e宝工坊随包内置，仍复用登录窗口、账号独立 Chromium session、代理和 Puppeteer 发布实现。

随包 Worker 固定使用 Electron 24.8.8（与源码依赖一致）。头条草稿已在该运行时和既有账号资料下通过一次受控自动保存；曾实验的 Electron 43 会改变 Chromium Profile Cookie 格式，未经正式迁移验证不用于构建用户安装包。

## 构建

使用仓库规定的 Node.js 20 和 Yarn：

```bash
yarn install --frozen-lockfile
yarn test:publisher-worker
yarn build:publisher-worker:universal
```

产物为：

```text
build/publisher-worker/mac-universal/MatrixMedia Publisher Worker.app
```

该 App 的主入口是 `dist/electron/publisher-worker.js`。启动时必须携带：

```text
--publisher-worker --data-dir <e宝独立数据目录>
```

## 私有协议

Supervisor 与 Worker 使用逐行 JSON（NDJSON），但传输通道按平台区分：

- macOS 使用 Worker 的 stdin/stdout；stdout 只写协议响应帧。
- Windows 由 Supervisor 先监听随机的本机命名管道，再通过 `EBAO_PUBLISHER_PIPE` 和 `EBAO_PUBLISHER_PIPE_TOKEN` 向 Worker 传入管道名与 64 个十六进制字符（32 字节）的令牌。Worker 连接后先发送 `{"auth":"<令牌>"}\n` 认证帧；Supervisor 验证成功后，双方才在同一管道连接上传输 NDJSON 请求和响应。Windows 缺少有效管道配置时启动失败，不回退到 stdin/stdout。

普通日志在 stderr 可用时写入 stderr。Windows GUI 进程可能没有可用的 stderr 句柄，不能依赖它承载协议或启动诊断。认证帧和令牌不写入日志。认证完成后的请求形状：

```json
{"id":"1","method":"system.handshake","params":{}}
```

公开方法：

- `system.handshake`、`system.health`、`system.shutdown`
- `system.capabilities`（协议 v2，按平台和内容类型声明可提交模式）
- `accounts.list/create/update/delete`
- `accounts.openLogin/checkLogin/openDashboard`
- `accounts.importPreview/importApply`
- `submissions.create/list`

账号响应不含 Cookie 或 Chromium partition。提交记录只暴露提交时间、内容类型、内容 ID、模式和账号名称快照，不暴露内部执行状态。schema v1 视频记录迁移到 v2 时保持原 workId 和历史。发布前会同步校验所有目标账号登录态；文章、图文内容包先复制为不可变快照，再持久化，成功后才返回 `accepted: true`。

用户要求开放已有适配器供自行验证。Worker 现在默认开放掘金、B站、头条、百家号文章以及小红书、抖音图文和公众号图片消息的草稿与立即发布；仍拒绝没有实际适配器的内容类型组合，不会回落到视频处理器。开放能力不等于真实平台验收通过：平台权限、页面改版和风控仍可能使任务在接受后失败或结果不明确，用户须到对应账号后台确认。`EBAO_PUBLISHER_EXPERIMENTAL_CAPABILITIES` 不再决定这些能力。

头条与百家号文章通过按平台、内容类型、提交方式分流的适配器处理；文章不会进入同平台视频处理器。公共 Markdown 中的 `ebao-asset://<UUID>` 只允许引用本草稿素材，接受前校验 SHA-256（旧素材至少检查尺寸、格式和快照前后哈希），随后复制不可变内容快照。百家号使用账号原有 partition 上传正文图和封面；头条正文配图和封面由用户在平台后台手动上传。头条准备阶段把正文图片替换为编号占位，并提示手动设置封面；包含这些调整的提交转存草稿。任务结束后自动关闭执行窗口，用户从发布记录打开平台草稿，补图、设置封面后再次保存。头条适配器不调用图片上传控件或接口。平台没有可观察的草稿/发布确认，或点击后遇到验证、超时、异常时记为内部未知，不自动重试。掘金和 B站专栏仍最多接受一张封面，正文插图不开放。

头条文章转存草稿在填写标题后直接把正文写入编辑器，不等待“仅标题”初始保存请求。编辑器须能读到规范化后的完整正文（包括手动补图占位），平台字数不能为 0；完整正文保存请求须包含这份正文并返回业务码 0。保存回执或对应请求提供 `pgc_id` 时，使用该 ID 重新打开并核验标题和正文；没有 ID 时才按草稿箱中的唯一精确标题核对，同名歧义不会记为成功。同账号、同内置浏览器的对照中，手动可见后台完整保存返回业务码 0，隐藏自动窗口的初始请求曾返回 7050。因此仅头条 Worker 文章“转存草稿”运行时保持可见，且不使用发布窗口的反检测脚本和 puppeteer-extra 注入；立即发布的运行可见性、其他平台和视频的窗口策略不变。头条 Worker 任务成功、失败或超时后均关闭执行窗口并释放账号，失败截图在关闭前保存。Worker 不自行拼接头条签名 URL，也不会在失败或未知结果后自动重试。正文图片和封面仍须由用户从平台后台上传并核对保存结果。

真实验收顺序：每个平台依次验证重启后登录、纯文草稿、含封面和正文插图的草稿、受控直接发布、用相同 partition 打开后台核对。缺少发文权限或遇到新页面结构时保留实验能力关闭，调整适配器并重新测试，不把 Worker 的内部状态同步给 e宝页面。

头条文章摘要和标签只保存在本地草稿，不向平台提交，也不阻止转存草稿。百家号标签输入尚未取得可靠的无副作用提交方式；若草稿含标签，接受前拒绝。百家号摘要会在存在对应平台输入框时写入并复核，找不到输入框则停止任务而不会点击保存或发布。

## 恢复语义

- 未开始的 `queued` 提交在 Worker 重启后继续。
- 已进入 `running` 但被中断的提交转为内部 `unknown`，不会自动重发。
- Worker 内部全局串行执行，且 e宝模式将单次尝试限制为 1。
- 登录或发布窗口关闭后 Worker 仍保持运行，继续处理同一提交的后续平台；`system.shutdown` 或 Supervisor 关闭协议连接（macOS stdin、Windows 命名管道）才触发退出。
- 登录页/平台后台与同账号的排队、校验或执行任务互斥；头条文章草稿在执行时可见，任务结束自动关闭执行窗口并释放账号，其他平台继续使用各自的窗口策略。
- 小红书固定使用内置 Electron Chromium；番茄视频区分“一键发布”和“保存草稿”，草稿模式绝不回退为直接发布。
- UUID 或导入账号的 partition 不经过旧 GUI 的手机号后缀截断，账号代理随该 partition 一起复用。
- 导入独立 MatrixMedia 账号时先复制到临时目录，再以同文件系统重命名方式安装 session；源目录不移动、不删除。
- 失败截图和 MatrixMedia 内部发布记录写入 `--data-dir` 下的隔离目录，不污染独立 MatrixMedia 数据。

本协议是 e宝与内置 Helper 之间的私有本机接口，不替代 MatrixMedia 原有 CLI、HTTP API 或 MCP 契约。

微信公众号（`wxmp`）是支持文章和图片消息的独立平台，不复用视频号 Cookie。`accounts.create` 需要 `appId` 和 `appSecret`；Worker 用 macOS 安全存储加密 AppSecret，公开账号列表不返回凭据。`accounts.checkLogin` 仅验证接口调用凭据，草稿与发布权限还要由公众号侧配置。文章适配器使用微信官方草稿箱和发布接口；“立即发布”不是群发。公众号文章上传前对平台副本处理：正文 JPEG/PNG 小于 1MB、封面 JPEG/PNG 小于 10MB，无法满足时停止并提示更换图片，原始快照不改写。提交发布超时或状态未定时不自动重试，需到公众号后台核对。

调试任一平台账号后台页面时，先在 MatrixMedia 目录用 Node 20 运行 `npm run build:publisher-worker:account-name`，再从仓库根目录执行 `corepack yarn dev:beta:publisher-tabs`。此命令将 Beta 指向刚构建的 `build/publisher-worker-account-name/mac-universal/MatrixMedia Publisher Worker.app`。需要调试控制台时改用 `corepack yarn dev:beta:publisher-debug`，它会传入 `EBAO_PUBLISHER_ACCOUNT_DEVTOOLS=1`，为账号后台及编辑页签打开独立 DevTools。平台编辑页通过 `window.open` 或 `target=_blank` 打开时，Worker 允许同平台 HTTPS 页面沿用该账号 session，并在 macOS 上并入该账号后台窗口的原生页签；跨平台及非 HTTPS 地址仍被拦截。修改 Worker 源码后须重新构建 Helper 并重启 e宝工坊才会生效。

## 登录状态检查

Worker、独立 GUI 和 CLI 共用本机 Cookie 判定。小红书检查创作者 access token、创作者 session 和用户 ID，不要求 customer 站点的 SSO Cookie；会话 Cookie 无持久有效期时仍可用，不虚构 90 天有效期。凭据缺失、过期或有效期异常返回未登录；读取失败及公众号网络/HTTP 异常返回状态未知。此检查不请求平台登录接口，不能证明服务端未撤销凭据或拥有发文权限，实际发布仍须平台确认。

### 抖音与公众号图文

`dy:image-note` 支持 `draft/publish`，复用隔离的浏览器账号会话和单次提交流程。图片上传、身份及顺序、标题正文、自主声明、可见提交按钮和本次成功回执均须核对；失败或不确定结果保留窗口、截图，不自动重试。缺少可绑定的图片信息或明确成功回执时必须停止。

`wxmp:image-note` 支持 `draft/publish`，使用官方 `newspic` 草稿类型；最多 20 张，Unicode 标题最多 32 个字符，首图封面，正文为纯文本。按素材顺序上传永久图片；WebP/超限图片只处理上传副本。`draft/get` 必须核对类型、标题、正文和图片 media_id 顺序，核对失败禁止调用 `freepublish/submit`。发布受理后查询状态，超时不自动重试；账号仍须满足官方发布接口权限和 IP 白名单要求。`wxmp:article` 保持 `news` 流程。视频号图文未开放。
