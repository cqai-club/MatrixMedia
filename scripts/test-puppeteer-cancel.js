"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { build } = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");
fs.mkdirSync(outDir, { recursive: true });

const bundlePath = path.join(outDir, "puppeteerFile.cjs");

const stubModules = new Map([
  [
    "electron",
    "module.exports = { ipcMain: { on() {} }, app: {}, BrowserWindow: function BrowserWindow() {}, dialog: {} };",
  ],
  ["puppeteer-core", "module.exports = {};"],
  [
    "puppeteer-extra",
    "module.exports = { addExtra() { return { use() {} }; } };",
  ],
  ["puppeteer-in-electron", "module.exports = {};"],
  [
    "puppeteer-extra-plugin-stealth",
    "module.exports = function StealthPlugin() { return {}; };",
  ],
  ["./Type", "module.exports = {};"],
  [
    "./upLoad/uploadTimeouts.js",
    "exports.UPLOAD_WINDOW_AUTO_CLOSE_MS = 60000;",
  ],
  [
    "./upLoad/closeWindow.js",
    "exports.skipCloseConfirmation = function skipCloseConfirmation() {};",
  ],
]);

async function main() {
  await build({
    entryPoints: [path.join(root, "src/main/services/puppeteerFile.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundlePath,
    plugins: [
      {
        name: "puppeteer-cancel-test-stubs",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (!stubModules.has(args.path)) return null;
            return { path: args.path, namespace: "stub" };
          });
          build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
            contents: stubModules.get(args.path),
            loader: "js",
          }));
        },
      },
    ],
  });

  const {
    createPuppeteerTaskRuntime,
    createPublishAttemptTransport,
    normalizePuppeteerVideoTaskData,
  } = require(bundlePath);

  // 图文失败必须先交付原始原因并结束任务，关窗回执不能覆盖它。
  for (const result of [
    { status: false, message: "等待小红书图文图片上传完成超时" },
    { status: true, publishAbnormal: true, needsAttention: true, message: "平台结果待确认" },
    { status: true, message: "图文草稿已提交" },
  ]) {
    const replies = [];
    let finished = false;
    let finishes = 0;
    const transport = createPublishAttemptTransport(
      { publisherWorker: true, pt: "小红书", textType: "image-note" },
      { reply: (channel, payload) => replies.push({ channel, payload }) },
      () => finished,
      () => { finished = true; finishes += 1; },
    );
    transport.reply("puppeteerFile-done", result);
    transport.reply("puppeteerFile-done", { status: false, message: "窗口已关闭，任务结束" });
    assert.deepStrictEqual(replies, [{ channel: "puppeteerFile-done", payload: result }]);
    assert.strictEqual(finishes, 1);
  }
  const legacyFailure = { status: false, message: "旧 GUI 发布失败" };
  const legacy = createPublishAttemptTransport({}, { reply() { assert.fail("旧 GUI 失败仍应交给重试路径"); } },
    () => false, () => assert.fail("旧 GUI 尚未完成"));
  assert.throws(() => legacy.reply("puppeteerFile-done", legacyFailure), error => error._mmUploadFailurePayload === legacyFailure);

  const articleData = {
    textType: "article",
    pt: "掘金",
    data: { title: "文章标题", content: "正文", bt2: "文章摘要" },
  };
  const originalArticleData = JSON.parse(JSON.stringify(articleData));
  assert.strictEqual(normalizePuppeteerVideoTaskData(articleData), articleData);
  assert.deepStrictEqual(articleData, originalArticleData);

  const videoData = {
    textType: "local",
    pt: "抖音",
    data: { bt1: "视频标题", bt2: "视频简介", bq: "#旅行" },
  };
  normalizePuppeteerVideoTaskData(videoData);
  assert.strictEqual(videoData.data.title, "视频标题");
  assert.strictEqual(videoData.data.description, "视频简介");
  assert.deepStrictEqual(videoData.data.tags, ["旅行"]);

  const started = [];
  const runtime = createPuppeteerTaskRuntime({
    runTask(task, done) {
      started.push(task.data.taskId);
      task.setCancelHandler(() => {
        done();
      });
    },
  });

  runtime.enqueueTask({ taskId: "active" }, { reply() {} });
  runtime.enqueueTask({ taskId: "queued-1" }, { reply() {} });
  runtime.enqueueTask({ taskId: "queued-2" }, { reply() {} });

  assert.deepStrictEqual(started, ["active"]);

  const result = runtime.cancelPuppeteerTasks("获取状态已中断上传");

  assert.deepStrictEqual(result, { active: 1, queued: 2, total: 3 });
  assert.deepStrictEqual(started, ["active"]);
  assert.strictEqual(runtime.getQueueSize(), 0);
  assert.strictEqual(runtime.isBusy(), false);

  runtime.enqueueTask({ taskId: "after-cancel" }, { reply() {} });

  assert.deepStrictEqual(started, ["active", "after-cancel"]);

  console.log("test-puppeteer-cancel passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
