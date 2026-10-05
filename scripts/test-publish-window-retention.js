"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { build } = require("esbuild");

const root = path.join(__dirname, "..");
const output = path.join(root, "test/.cache/publish-window-retention.cjs");
fs.mkdirSync(path.dirname(output), { recursive: true });

const stubs = new Map([
  ["electron", `module.exports = {
    ipcMain: { on() {} }, app: { getPath() { return "/tmp"; } },
    BrowserWindow: globalThis.__testBrowserWindow,
    dialog: { showMessageBoxSync() { return 1; } },
    safeStorage: {}, session: { fromPartition() { return {}; } },
  };`],
  ["puppeteer-core", "module.exports = { driver: 'core' };"],
  ["puppeteer-extra", "module.exports = { addExtra() { return { driver: 'stealth', use() {} }; } };"],
  ["puppeteer-in-electron", `module.exports = {
    connect: async (_app, driver) => { globalThis.__pieDrivers.push(driver.driver); return { disconnect() {} }; },
    getPage: async (_browser, win) => ({
      evaluateOnNewDocument: async () => { globalThis.__injections++; }, setUserAgent: async () => {},
      url: () => win.url || "", waitForTimeout: async () => {},
    }),
  };`],
  ["puppeteer-extra-plugin-stealth", "module.exports = () => ({});"],
  ["./Type", "module.exports = {};"],
  ["../services/publishVideo.js", "exports.runSingleFilePublish = async item => { globalThis.__publishedAccounts.push(item.phone); return { exitCode: 0, status: 'success' }; };"],
  ["./article.js", "exports.runToutiaoArticle = async () => { globalThis.__ttExecutions++; return globalThis.__ttOutcome; };"],
  ["./proxyConfig.js", "exports.applyAccountProxyForTask = async () => ({ applied: false }); exports.applyAccountProxyToSession = async () => {};"],
  ["./upLoad/xhsChrome.js", "module.exports = async () => {};"],
  ["./upLoad/xhsImageNote.js", "module.exports = async () => {};"],
  ["./upLoad/blblArticle.js", "module.exports = async () => {};"],
  ["./upLoad/ttArticle.js", "module.exports = async (...args) => globalThis.__ttHandler(...args);"],
  ["./upLoad/bjhArticle.js", "module.exports = async () => {};"],
]);

(async () => {
await build({
  stdin: {
    contents: `
      export { registerPublishWindow, hasOpenPublishWindow, hasAnyOpenPublishWindow, afterPublishWindowClosed,
        isToutiaoWorkerTask, toutiaoFailureMessage } from "./src/main/services/publishWindowRegistry.js";
      export { replyPublishFailure, replyPublishOutcome } from "./src/main/services/upLoad/publishOutcome.js";
      export { PublisherAccounts } from "./src/main/publisher-worker/accounts.js";
      export { PublisherWorkerService } from "./src/main/publisher-worker/service.js";
      export { runPuppeteerTask, cancelPuppeteerTasks, hasActivePublishTasks } from "./src/main/services/puppeteerFile.js";
    `,
    resolveDir: root,
    sourcefile: "window-retention-entry.js",
  },
  bundle: true, platform: "node", format: "cjs", outfile: output,
  plugins: [{
    name: "window-retention-stubs",
    setup(build) {
      build.onResolve({ filter: /.*/ }, args => stubs.has(args.path)
        ? { path: args.path, namespace: "stub" } : null);
      build.onLoad({ filter: /.*/, namespace: "stub" }, args => ({
        contents: stubs.get(args.path), loader: "js",
      }));
    },
  }],
});

const created = [];
class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.destroyed = false;
    this.shown = 0;
    this.focused = 0;
    this.url = "";
    this.webContents = {
      setWindowOpenHandler() {}, on() {}, setUserAgent() {}, isDestroyed: () => this.destroyed,
    };
    created.push(this);
  }
  isDestroyed() { return this.destroyed; }
  show() { this.shown++; }
  focus() { this.focused++; }
  async loadURL(url) { this.url = url; }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
  destroy() { this.close(); }
}
globalThis.__testBrowserWindow = FakeWindow;
globalThis.__publishedAccounts = [];
globalThis.__pieDrivers = [];
globalThis.__injections = 0;
globalThis.__ttHandler = async () => {};
globalThis.__ttExecutions = 0;
process.env.MATRIXMEDIA_DATA_DIR = "/tmp";

const tools = require(output);
const partitionA = "persist:retained-a";
const partitionB = "persist:retained-b";
const draft = {
  publisherWorker: true, pt: "头条", textType: "article",
  publishToDraft: true, closeWindowAfterPublish: true,
};
const store = {
  account(id) {
    return id === "a" ? { id, partition: partitionA, platform: "tt", pt: "头条" }
      : id === "b" ? { id, partition: partitionB, platform: "tt", pt: "头条" } : null;
  },
};
const accounts = new tools.PublisherAccounts(store, () => false);

async function waitUntil(check, message) {
  const deadline = Date.now() + 6000;
  while (!check() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(check(), message);
}

async function waitForWindow(previousCount) {
  const deadline = Date.now() + 3000;
  while (created.length <= previousCount && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(created.length > previousCount, "task should open a BrowserWindow");
  const win = created.at(-1);
  while (!win.url && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(win.url, "publish page should finish initial navigation");
  return win;
}

  // A close during initial navigation must release the account partition.
  const early = new FakeWindow();
  tools.registerPublishWindow(partitionA, early);
  assert.strictEqual(tools.hasOpenPublishWindow(partitionA), true);
  early.close();
  assert.strictEqual(tools.hasOpenPublishWindow(partitionA), false);
  const retainedCopies = new FakeWindow();
  tools.registerPublishWindow(partitionA, retainedCopies);
  let copiesCleaned = 0;
  tools.afterPublishWindowClosed(partitionA, () => { copiesCleaned++; });
  assert.strictEqual(copiesCleaned, 0);
  retainedCopies.close();
  assert.strictEqual(copiesCleaned, 1);
  const legacyWithoutPartition = new FakeWindow();
  tools.registerPublishWindow("", legacyWithoutPartition);
  assert.strictEqual(tools.hasActivePublishTasks(), true);
  legacyWithoutPartition.close();
  assert.strictEqual(tools.hasActivePublishTasks(), false);

  const failedWindow = new FakeWindow();
  tools.registerPublishWindow(partitionA, failedWindow);
  assert.throws(() => accounts.assertIdle("a"), error => error.code === "account-window-open");
  await assert.rejects(accounts.openLogin({ id: "a" }), error => error.code === "account-window-open");
  await assert.rejects(accounts.openDashboard({ id: "a" }), error => error.code === "account-window-open");
  await assert.rejects(accounts.remove({ id: "a" }), error => error.code === "account-window-open");
  const replies = [];
  await tools.replyPublishFailure({
    page: null, data: draft, window: failedWindow,
    event: { reply: (_channel, payload) => replies.push(payload) },
    message: "文章标题未写入",
  });
  assert.strictEqual(failedWindow.isDestroyed(), true);
  assert.strictEqual(replies[0].status, false);
  assert.strictEqual(replies[0].message, "文章标题未写入");
  assert.strictEqual(tools.hasOpenPublishWindow(partitionA), false);
  assert.doesNotThrow(() => accounts.assertNoOpenWindow("b"));
  assert.doesNotThrow(() => accounts.assertIdle("b"));
  assert.doesNotThrow(() => accounts.assertNoOpenWindow("a"));
  assert.doesNotThrow(() => accounts.assertIdle("a"));

  const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ebao-window-retention-"));
  try {
    const service = new tools.PublisherWorkerService(serviceRoot);
    const tt = service.store.addAccount({ displayName: "头条账号", platform: "tt", pt: "头条" });
    const dy = service.store.addAccount({ displayName: "抖音账号", platform: "dy", pt: "抖音" });
    const retained = new FakeWindow();
    tools.registerPublishWindow(tt.partition, retained);
    const blocked = service.store.createSubmission({
      workId: "blocked", file: "/tmp/unused.mp4", title: "阻断测试", mode: "draft",
    }, [tt, dy]);
    await service.drain();
    assert.strictEqual(service.store.submission(blocked.id).state, "failed");
    assert.match(service.store.submission(blocked.id).message, /未开始/u);
    assert.deepStrictEqual(globalThis.__publishedAccounts, []);

    const xhs = service.store.addAccount({ displayName: "小红书账号", platform: "xhs", pt: "小红书" });
    const oldImageNote = service.store.createSubmission({
      contentType: "image-note", contentId: "11111111-1111-4111-8111-111111111111", revision: 1,
      snapshotDirectory: "/tmp/unused-image-note", title: "旧图文", mode: "draft",
    }, [xhs, tt]);
    await service.drain();
    assert.strictEqual(service.store.submission(oldImageNote.id).state, "failed");
    assert.match(service.store.submission(oldImageNote.id).message, /头条账号当前不支持.*未开始/u);
    assert.deepStrictEqual(globalThis.__publishedAccounts, []);

    const other = service.store.createSubmission({
      workId: "other", file: "/tmp/unused.mp4", title: "其他账号", mode: "draft",
    }, [dy]);
    await service.drain();
    assert.strictEqual(service.store.submission(other.id).state, "completed");
    assert.deepStrictEqual(globalThis.__publishedAccounts, [dy.id]);
    retained.close();

    const allowed = service.store.createSubmission({
      workId: "allowed", file: "/tmp/unused.mp4", title: "已关闭窗口", mode: "draft",
    }, [tt]);
    await service.drain();
    assert.strictEqual(service.store.submission(allowed.id).state, "completed");
    assert.deepStrictEqual(globalThis.__publishedAccounts, [dy.id, tt.id]);
    const sph = service.store.addAccount({ displayName: "视频号账号", platform: "sph", pt: "视频号" });
    const multi = service.store.createSubmission({
      workId: "multi", file: "/tmp/unused.mp4", title: "多平台顺序", mode: "draft",
    }, [dy, sph]);
    await service.drain();
    assert.deepStrictEqual(multi.targets.map(item => item.accountId), [dy.id, sph.id]);
    assert.deepStrictEqual(service.store.submission(multi.id).result.results.map(item => item.accountId), [sph.id, dy.id]);
    assert.deepStrictEqual(globalThis.__publishedAccounts, [dy.id, tt.id, sph.id, dy.id]);

    // 结束关窗不代表平台结果成功；unknown 持久保留，后续 drain 不会自动重发。
    const contentId = "22222222-2222-4222-8222-222222222222";
    const snapshotDirectory = path.join(serviceRoot, "article-snapshot");
    fs.mkdirSync(path.join(snapshotDirectory, "assets"), { recursive: true });
    fs.writeFileSync(path.join(snapshotDirectory, "manifest.json"), JSON.stringify({
      id: contentId, revision: 1, contentType: "article", title: "收尾测试", body: "完整正文",
      summary: "", tags: [], assets: [], coverAssetId: null, creativeStatement: "none",
    }));
    globalThis.__ttOutcome = { exitCode: 1, status: "unknown", message: "Waiting failed: 45000ms exceeded" };
    const unknown = service.store.createSubmission({
      contentType: "article", contentId, revision: 1, snapshotDirectory, title: "收尾测试", mode: "draft",
    }, [tt]);
    await service.drain();
    const uncertainResult = service.store.submission(unknown.id);
    assert.strictEqual(uncertainResult.state, "unknown");
    assert.strictEqual(uncertainResult.result.success, false);
    assert.strictEqual(uncertainResult.result.succeeded, 0);
    assert.strictEqual(uncertainResult.result.results[0].message, "头条草稿保存超时，请从发布记录打开平台稿件检查");
    assert.strictEqual(service.busyAccounts.has(tt.id), false);
    assert.doesNotThrow(() => service.accounts.assertIdle(tt.id));
    await service.drain();
    assert.strictEqual(globalThis.__ttExecutions, 1, "未知结果不能被自动重新执行");

    globalThis.__ttOutcome = { exitCode: 0, status: "success", message: "头条草稿已保存" };
    const nextArticle = service.store.createSubmission({
      contentType: "article", contentId, revision: 1, snapshotDirectory, title: "收尾测试", mode: "draft",
    }, [tt]);
    await service.drain();
    assert.strictEqual(service.store.submission(nextArticle.id).state, "completed");
    assert.strictEqual(globalThis.__ttExecutions, 2, "同账号可以执行用户新建的下一项任务");
    const onShutdown = new FakeWindow();
    tools.registerPublishWindow(tt.partition, onShutdown);
    await service.dispose();
    assert.strictEqual(onShutdown.isDestroyed(), true);
    assert.strictEqual(tools.hasOpenPublishWindow(tt.partition), false);
  } finally {
    fs.rmSync(serviceRoot, { recursive: true, force: true });
  }

  const successWindow = new FakeWindow();
  successWindow._mmRetainedForInspection = true;
  tools.registerPublishWindow(partitionA, successWindow);
  const successReplies = [];
  await tools.replyPublishOutcome({
    page: { url: () => "https://mp.toutiao.com/profile_v4/manage/draft", waitForTimeout: async () => {} },
    data: { ...draft, closeWindowAfterPublish: false }, window: successWindow,
    event: { reply: (_channel, payload) => successReplies.push(payload) },
    isDraftMode: true, waitMs: 0,
  });
  assert.strictEqual(successReplies[0].status, true);
  assert.doesNotMatch(successReplies[0].message, /窗口已保留|账号不能|结果待确认/u);
  assert.strictEqual(successWindow.isDestroyed(), true, "头条结束关窗不受旧保留标记或关闭设置影响");
  assert.strictEqual(tools.hasOpenPublishWindow(partitionA), false);

  const directPublishWindow = new FakeWindow();
  tools.registerPublishWindow(partitionA, directPublishWindow);
  await tools.replyPublishOutcome({
    page: { url: () => "https://mp.toutiao.com/profile_v4/manage/article", waitForTimeout: async () => {} },
    data: { ...draft, publishToDraft: false }, window: directPublishWindow,
    event: { reply() {} }, isDraftMode: false, waitMs: 0,
  });
  assert.strictEqual(directPublishWindow.isDestroyed(), true, "direct publish keeps its existing close behavior");

  // 先留下失败画面，再交付失败回执并关闭；原关闭设置不得保留头条窗口。
  const screenshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ebao-window-shot-"));
  const shotWindow = new FakeWindow();
  tools.registerPublishWindow(partitionA, shotWindow);
  const lifecycle = [];
  shotWindow.on("closed", () => lifecycle.push("closed"));
  process.env.MATRIXMEDIA_DATA_DIR = screenshotRoot;
  try {
    await tools.replyPublishFailure({
      page: { screenshot: async () => {
        assert.strictEqual(shotWindow.isDestroyed(), false);
        lifecycle.push("screenshot");
        return Buffer.from("test-screenshot");
      } },
      data: { ...draft, closeWindowAfterPublish: false }, window: shotWindow, closeWindow: false,
      event: { reply: (_channel, value) => {
        lifecycle.push("reply");
        assert.strictEqual(value.status, false);
        assert.ok(fs.existsSync(value.failScreenshot));
        assert.strictEqual(value.message, "头条草稿保存超时，请从发布记录打开平台稿件检查");
      } },
      message: "Waiting failed: 45000ms exceeded",
    });
    assert.deepStrictEqual(lifecycle, ["screenshot", "reply", "closed"]);
    assert.strictEqual(tools.hasOpenPublishWindow(partitionA), false);
  } finally {
    process.env.MATRIXMEDIA_DATA_DIR = "/tmp";
    fs.rmSync(screenshotRoot, { recursive: true, force: true });
  }

  const nonToutiao = new FakeWindow();
  nonToutiao._mmRetainedForInspection = true;
  tools.registerPublishWindow(partitionB, nonToutiao);
  await tools.replyPublishFailure({
    page: null, data: { ...draft, pt: "抖音" }, window: nonToutiao,
    event: { reply() {} }, message: "抖音草稿需人工检查",
  });
  assert.strictEqual(nonToutiao.isDestroyed(), false, "其他平台显式保留窗口策略不变");
  assert.strictEqual(nonToutiao.shown, 1);
  nonToutiao.close();

  // 运行中的草稿可见且不注入反检测脚本；超时后自动关窗，释放同账号和队列。
  const payload = { ...draft, taskId: "timeout", partition: partitionA,
    url: "https://mp.toutiao.com/profile_v4/graphic/publish?from=toutiao_pc",
    useragent: "Test UA", publishOptions: { maxAttempts: 1 } };
  let before = created.length;
  const timeoutReplies = [];
  const scheduled = [];
  const nativeSetTimeout = global.setTimeout;
  let timeoutWindow;
  try {
    global.setTimeout = (fn, delay, ...args) => {
      scheduled.push(delay);
      return nativeSetTimeout(fn, delay, ...args);
    };
    tools.runPuppeteerTask(payload, { reply: (_channel, value) => timeoutReplies.push(value) });
    timeoutWindow = await waitForWindow(before);
  } finally {
    global.setTimeout = nativeSetTimeout;
  }
  assert.strictEqual(scheduled.includes(4 * 60 * 60 * 1000), false,
    "头条草稿使用 Worker 提交超时，不能等待四小时兜底");
  assert.strictEqual(timeoutWindow.options.show, true);
  assert.strictEqual(globalThis.__pieDrivers.at(-1), "core");
  assert.strictEqual(globalThis.__injections, 0, "头条运行时继续使用正常可见页面，不注入反检测脚本");
  assert.strictEqual(tools.hasOpenPublishWindow(partitionA), true);
  tools.cancelPuppeteerTasks("内容提交超时，已停止浏览器任务");
  assert.strictEqual(timeoutWindow.isDestroyed(), true);
  assert.strictEqual(tools.hasOpenPublishWindow(partitionA), false);

  // 真实任务回执链只完成一次，并在 queueDone 前释放同账号窗口。
  for (const status of [true, false]) {
    let callback;
    const resultReplies = [];
    let finishes = 0;
    globalThis.__ttHandler = async (page, data, win, event, done) => {
      callback = { event, done };
      if (status) {
        await tools.replyPublishOutcome({ page, data, window: win, event,
          isDraftMode: true, waitMs: 0, successMessage: "头条草稿已保存" });
      } else {
        await tools.replyPublishFailure({ page, data, window: win, event, message: "文章标题未写入" });
      }
      done();
    };
    before = created.length;
    tools.runPuppeteerTask({ ...payload, taskId: `result-${status}`, closeWindowAfterPublish: false },
      { reply: (_channel, value) => resultReplies.push(value) }, () => {
        finishes++;
        assert.strictEqual(tools.hasOpenPublishWindow(partitionA), false,
          "任务完成回调之前已释放同账号窗口");
      });
    const resultWindow = await waitForWindow(before);
    assert.strictEqual(resultWindow.options.show, true);
    await waitUntil(() => finishes === 1, "平台结果应该结束本项任务");
    assert.strictEqual(resultWindow.isDestroyed(), true);
    assert.strictEqual(resultReplies.length, 1);
    assert.strictEqual(resultReplies[0].status, status);
    callback.event.reply("puppeteerFile-done", { ...payload, status: !status });
    callback.done();
    assert.strictEqual(resultReplies.length, 1, "迟到或重复回执不能覆盖已完成结果");
    assert.strictEqual(finishes, 1, "finishOnce 只推进队列一次");
    assert.strictEqual(tools.hasActivePublishTasks(), false);
  }
  globalThis.__ttHandler = async () => {};
  assert.strictEqual(tools.hasActivePublishTasks(), false);
  assert.strictEqual(timeoutReplies.length, 1, "程序关窗不能覆盖真实失败回执");
  assert.strictEqual(timeoutReplies[0].status, false);
  assert.doesNotMatch(timeoutReplies[0].message, /窗口已保留|结果待确认|Waiting failed/u);
  await tools.replyPublishOutcome({
    page: { url: () => payload.url, waitForTimeout: async () => {} },
    data: payload, window: timeoutWindow, event: { reply() {} },
    isDraftMode: true, waitMs: 0,
  });
  assert.strictEqual(timeoutWindow.isDestroyed(), true, "迟到的成功回调不能重新保留已关闭窗口");
  assert.strictEqual(tools.hasOpenPublishWindow(partitionA), false);

  before = created.length;
  const shutdownReplies = [];
  tools.runPuppeteerTask({ ...payload, taskId: "shutdown" },
    { reply: (_channel, value) => shutdownReplies.push(value) });
  const shutdownWindow = await waitForWindow(before);
  tools.cancelPuppeteerTasks("应用退出，已中断发布");
  assert.strictEqual(shutdownWindow.isDestroyed(), true);
  assert.strictEqual(tools.hasOpenPublishWindow(partitionA), false);
  assert.doesNotMatch(shutdownReplies.at(-1).message, /窗口已保留/u);
  assert.strictEqual(tools.hasAnyOpenPublishWindow(), false);

  const otherScheduled = [];
  const originalTimer = global.setTimeout;
  before = created.length;
  let otherWindow;
  try {
    global.setTimeout = (fn, delay, ...args) => {
      otherScheduled.push(delay);
      return originalTimer(fn, delay, ...args);
    };
    tools.runPuppeteerTask({ ...payload, pt: "百家号", partition: partitionB, taskId: "other" },
      { reply() {} });
    otherWindow = await waitForWindow(before);
  } finally {
    global.setTimeout = originalTimer;
  }
  assert.ok(otherScheduled.includes(4 * 60 * 60 * 1000),
    "other platforms should retain their existing fallback auto-close");
  tools.cancelPuppeteerTasks("应用退出，已中断发布");
  assert.strictEqual(otherWindow.isDestroyed(), true);
  console.log("test-publish-window-retention passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
