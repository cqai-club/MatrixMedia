# Publisher Worker（e宝工坊内置模式）

Worker 源码从 `feat/ebao-publisher-worker` 固定提交派生；文章扩展在 `codex/ebao-article-adapters` 开发。它不启动 MatrixMedia Vue 主窗口，只供 e宝工坊随包内置，仍复用登录窗口、账号独立 Chromium session、代理和 Puppeteer 发布实现。

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

Supervisor 通过 stdin/stdout 使用逐行 JSON（NDJSON）。stdout 只写响应帧，普通日志和 Chromium 日志写 stderr。请求形状：

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

用户要求开放已有适配器供自行验证。Worker 现在默认开放掘金、B站、头条、百家号文章以及小红书图文的草稿与立即发布；仍拒绝没有实际适配器的内容类型组合，不会回落到视频处理器。开放能力不等于真实平台验收通过：平台权限、页面改版和风控仍可能使任务在接受后失败或结果不明确，用户须到对应账号后台确认。`EBAO_PUBLISHER_EXPERIMENTAL_CAPABILITIES` 不再决定这些能力。

头条与百家号文章通过按平台、内容类型、提交方式分流的适配器处理；文章不会进入同平台视频处理器。公共 Markdown 中的 `ebao-asset://<UUID>` 只允许引用本草稿素材，接受前校验 SHA-256（旧素材至少检查尺寸、格式和快照前后哈希），随后复制不可变内容快照。Worker 使用账号原有 partition 上传正文图，替换为平台 HTTPS 图片地址后再写入文章编辑器；上传失败时不点击保存/发布。封面独立选取，可复用正文图片。平台没有可观察的草稿/发布确认，或点击后遇到验证、超时、异常时记为内部未知，不自动重试。掘金和 B站专栏仍最多接受一张封面，正文插图不开放。

头条文章转存草稿在填写标题后先聚焦仍为空的正文编辑器，使标题框失焦并触发初始自动保存；必须等“仅标题”保存返回业务码 0，页面显示“草稿已保存”，随后才写入正文。完整正文保存请求还必须携带草稿标识、返回业务码 0，最后到草稿箱核对标题。同账号、同内置浏览器、同标题正文的对照中，手动可见后台先后两次保存均返回业务码 0 且草稿箱可见；隐藏自动窗口的初始请求返回 7050。因此仅头条 Worker 文章“转存草稿”窗口暂改为可见，且不使用发布窗口的反检测脚本和 puppeteer-extra 注入，以贴近可工作的账号后台；立即发布、其他平台和视频窗口策略不变。Worker 不自行拼接头条签名 URL，也不会在失败后自动重试。这个窗口对照修正尚未通过自动草稿真实验收，不应仅凭自动测试宣称已经修好。

真实验收顺序：每个平台依次验证重启后登录、纯文草稿、含封面和正文插图的草稿、受控直接发布、用相同 partition 打开后台核对。缺少发文权限或遇到新页面结构时保留实验能力关闭，调整适配器并重新测试，不把 Worker 的内部状态同步给 e宝页面。

两平台文章的标签输入尚未取得可靠的无副作用提交方式；若草稿含标签，接受前拒绝，不会悄悄丢弃标签。摘要会在存在对应平台输入框时写入并复核，找不到输入框则停止任务而不会点击保存或发布。

## 恢复语义

- 未开始的 `queued` 提交在 Worker 重启后继续。
- 已进入 `running` 但被中断的提交转为内部 `unknown`，不会自动重发。
- Worker 内部全局串行执行，且 e宝模式将单次尝试限制为 1。
- 登录或发布窗口关闭后 Worker 仍保持运行，继续处理同一提交的后续平台；只有 `system.shutdown` 或 Supervisor 关闭 stdin 才退出。
- 登录页/平台后台与同账号的排队、校验或执行任务互斥；发布窗口在 Worker 模式下保持隐藏。
- 小红书固定使用内置 Electron Chromium；番茄视频区分“一键发布”和“保存草稿”，草稿模式绝不回退为直接发布。
- UUID 或导入账号的 partition 不经过旧 GUI 的手机号后缀截断，账号代理随该 partition 一起复用。
- 导入独立 MatrixMedia 账号时先复制到临时目录，再以同文件系统重命名方式安装 session；源目录不移动、不删除。
- 失败截图和 MatrixMedia 内部发布记录写入 `--data-dir` 下的隔离目录，不污染独立 MatrixMedia 数据。

本协议是 e宝与内置 Helper 之间的私有本机接口，不替代 MatrixMedia 原有 CLI、HTTP API 或 MCP 契约。
