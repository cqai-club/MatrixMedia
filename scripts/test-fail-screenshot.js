"use strict";

/**
 * 验证「发布失败截图」：
 * 1. buildFailScreenshotName：平台/账号进文件名，非法字符被替换
 * 2. capturePublishFailureScreenshot：落盘 PNG，页面已关闭时返回空串且不抛错
 * 3. readFailScreenshotDataUrl：读回 base64 data URL，文件不存在时返回 ok:false
 * 4. pruneFailScreenshots：超期文件被清理，未超期保留
 * 5. replyPublishFailure / replyPublishOutcome：失败回执带 failScreenshot 字段
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");
fs.mkdirSync(outDir, { recursive: true });

const shotBundle = path.join(outDir, "failureScreenshot.cjs");
const outcomeBundle = path.join(outDir, "publishOutcome.cjs");

buildSync({
  entryPoints: [path.join(root, "src/main/services/upLoad/failureScreenshot.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: shotBundle,
  external: ["electron"],
});
buildSync({
  entryPoints: [path.join(root, "src/main/services/upLoad/publishOutcome.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: outcomeBundle,
  external: ["electron"],
});

const {
  buildFailScreenshotName,
  capturePublishFailureScreenshot,
  getFailScreenshotDir,
  readFailScreenshotDataUrl,
  pruneFailScreenshots,
  FAIL_SCREENSHOT_RETENTION_DAYS,
} = require(shotBundle);
const { replyPublishFailure, replyPublishOutcome } = require(outcomeBundle);

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mm-${name}-`));
}

(async () => {
  const previousDataRoot = process.env.MATRIXMEDIA_DATA_DIR;
  const isolatedDataRoot = tmpDir("worker-data");
  process.env.MATRIXMEDIA_DATA_DIR = isolatedDataRoot;
  assert.strictEqual(
    getFailScreenshotDir(),
    path.join(isolatedDataRoot, "fail-screenshots"),
    "Worker 截图必须留在独立数据目录"
  );
  if (previousDataRoot === undefined) delete process.env.MATRIXMEDIA_DATA_DIR;
  else process.env.MATRIXMEDIA_DATA_DIR = previousDataRoot;

  // 1. 文件名
  const name = buildFailScreenshotName(
    { pt: "小红书", phone: "1380000-1" },
    new Date(2026, 8, 22, 10, 3, 5, 7)
  );
  assert.strictEqual(name, "小红书-1380000-20260922-100305-007.png");
  const dirty = buildFailScreenshotName({ pt: "a/b:c*?", phone: "" });
  assert.ok(!/[\\/:*?"<>|]/.test(dirty), "文件名不应含非法字符");
  assert.ok(dirty.startsWith("a_b_c_"), "非法字符应替换成下划线");
  assert.ok(dirty.includes("未知账号"), "空账号应回退占位名");

  // 2. 截图落盘
  const dir = tmpDir("shot");
  const page = {
    isClosed: () => false,
    screenshot: async (opts) => {
      assert.strictEqual(opts.type, "png");
      return PNG_1PX;
    },
  };
  const file = await capturePublishFailureScreenshot(
    page,
    { pt: "抖音", phone: "1390000" },
    { dir }
  );
  assert.ok(file && fs.existsSync(file), "截图应已落盘");
  assert.strictEqual(fs.readFileSync(file).length, PNG_1PX.length);

  // 2.1 页面已关闭 / screenshot 抛错 → 返回空串不抛
  const closed = await capturePublishFailureScreenshot(
    { isClosed: () => true, screenshot: async () => PNG_1PX },
    { pt: "抖音" },
    { dir }
  );
  assert.strictEqual(closed, "");
  const boom = await capturePublishFailureScreenshot(
    {
      isClosed: () => false,
      screenshot: async () => {
        throw new Error("Target closed");
      },
    },
    { pt: "抖音" },
    { dir }
  );
  assert.strictEqual(boom, "", "截图异常不应向上抛");

  // 3. 读回 data URL
  const read = readFailScreenshotDataUrl(file);
  assert.strictEqual(read.ok, true);
  assert.ok(read.dataUrl.startsWith("data:image/png;base64,"));
  assert.strictEqual(
    readFailScreenshotDataUrl(path.join(dir, "not-exist.png")).ok,
    false
  );
  assert.strictEqual(readFailScreenshotDataUrl("").ok, false);

  // 4. 过期清理
  const pruneDir = tmpDir("prune");
  const fresh = path.join(pruneDir, "fresh.png");
  const stale = path.join(pruneDir, "stale.png");
  fs.writeFileSync(fresh, PNG_1PX);
  fs.writeFileSync(stale, PNG_1PX);
  const oldMs =
    Date.now() - (FAIL_SCREENSHOT_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
  fs.utimesSync(stale, oldMs / 1000, oldMs / 1000);
  const removed = pruneFailScreenshots(pruneDir);
  assert.strictEqual(removed, 1, "应只清理超期截图");
  assert.ok(fs.existsSync(fresh), "未超期截图应保留");
  assert.ok(!fs.existsSync(stale), "超期截图应被删除");

  // 5. 失败回执带截图路径
  const replyDir = tmpDir("reply");
  const calls = [];
  const event = { reply: (channel, payload) => calls.push({ channel, payload }) };
  const data = { pt: "快手", phone: "1370000", partition: "persist:test" };
  await replyPublishFailure({
    page: { isClosed: () => false, screenshot: async () => PNG_1PX },
    data,
    window: null,
    event,
    message: "上传失败",
    closeWindow: false,
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].payload.status, false);
  assert.strictEqual(calls[0].payload.message, "上传失败");
  assert.ok(
    calls[0].payload.failScreenshot,
    "失败回执应带 failScreenshot 路径"
  );

  // 5.1 发布异常（地址未变化）也截图
  const abnormalCalls = [];
  const abnormalPage = {
    url: () => "https://example.com/publish",
    waitForTimeout: async () => {},
    isClosed: () => false,
    screenshot: async () => PNG_1PX,
  };
  await replyPublishOutcome({
    page: abnormalPage,
    data,
    window: null,
    event: { reply: (c, p) => abnormalCalls.push({ channel: c, payload: p }) },
    urlBefore: "https://example.com/publish",
    waitMs: 0,
  });
  const abnormalPayload = abnormalCalls[0].payload;
  assert.strictEqual(abnormalPayload.publishAbnormal, true);
  assert.ok(
    abnormalPayload.failScreenshot,
    "发布异常回执应带 failScreenshot 路径"
  );

  // 5.2 正常成功不截图
  const okCalls = [];
  await replyPublishOutcome({
    page: {
      url: () => "https://example.com/success",
      waitForTimeout: async () => {},
      screenshot: async () => PNG_1PX,
    },
    data,
    window: null,
    event: { reply: (c, p) => okCalls.push({ channel: c, payload: p }) },
    urlBefore: "https://example.com/publish",
    waitMs: 0,
  });
  assert.strictEqual(okCalls[0].payload.status, true);
  assert.strictEqual(okCalls[0].payload.failScreenshot, undefined);

  console.log("✅ 发布失败截图测试全部通过");
})().catch((e) => {
  console.error("❌ 测试失败:", e);
  process.exit(1);
});
