# Publisher Worker（e宝工坊内置模式）

`feat/ebao-publisher-worker` 增加一个不启动 MatrixMedia Vue 主窗口的 Electron 入口。该入口只供 e宝工坊随包内置使用，仍复用 MatrixMedia 的登录窗口、Chromium session、代理和 Puppeteer 发布实现。

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
- `accounts.list/create/update/delete`
- `accounts.openLogin/checkLogin/openDashboard`
- `accounts.importPreview/importApply`
- `submissions.create/list`

账号响应不含 Cookie 或 Chromium partition。提交记录只暴露提交时间、作品、模式和账号名称快照，不暴露内部执行状态。发布前会同步校验所有目标账号登录态；持久化成功后才返回 `accepted: true`。

## 恢复语义

- 未开始的 `queued` 提交在 Worker 重启后继续。
- 已进入 `running` 但被中断的提交转为内部 `unknown`，不会自动重发。
- Worker 内部全局串行执行，且 e宝模式将单次尝试限制为 1。
- 登录页/平台后台与同账号的排队、校验或执行任务互斥；发布窗口在 Worker 模式下保持隐藏。
- 小红书固定使用内置 Electron Chromium；番茄视频区分“一键发布”和“保存草稿”，草稿模式绝不回退为直接发布。
- UUID 或导入账号的 partition 不经过旧 GUI 的手机号后缀截断，账号代理随该 partition 一起复用。
- 导入独立 MatrixMedia 账号时先复制到临时目录，再以同文件系统重命名方式安装 session；源目录不移动、不删除。
- 失败截图和 MatrixMedia 内部发布记录写入 `--data-dir` 下的隔离目录，不污染独立 MatrixMedia 数据。

本协议是 e宝与内置 Helper 之间的私有本机接口，不替代 MatrixMedia 原有 CLI、HTTP API 或 MCP 契约。
