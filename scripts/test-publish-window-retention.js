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
  ["puppeteer-core", "module.exports = {};"],
  ["puppeteer-extra", "module.exports = { addExtra() { return { use() {} }; } };"],
  ["puppeteer-in-electron", `module.exports = {
    connect: async () => ({ disconnect() {} }),
    getPage: async (_browser, win) => ({
      evaluateOnNewDocument: async () => {}, setUserAgent: async () => {},
      url: () => win.url || "", waitForTimeout: async () => {},
    }),
  };`],
  ["puppeteer-extra-plugin-stealth", "module.exports = () => ({});"],
  ["./Type", "module.exports = {};"],
  ["../services/publishVideo.js", "exports.runSingleFilePublish = async item => { globalThis.__publishedAccounts.push(item.phone); return { exitCode: 0, status: 'success' }; };"],
  ["./article.js", "module.exports = {};"],
  ["./proxyConfig.js", "exports.applyAccountProxyForTask = async () => ({ applied: false }); exports.applyAccountProxyToSession = async () => {};"],
  ["./upLoad/xhsChrome.js", "module.exports = async () => {};"],
  ["./upLoad/xhsImageNote.js", "module.exports = async () => {};"],
  ["./upLoad/blblArticle.js", "module.exports = async () => {};"],
  ["./upLoad/ttArticle.js", "module.exports = async () => {};"],
  ["./upLoad/bjhArticle.js", "module.exports = async () => {};"],
]);

(async () => {
await build({
  stdin: {
    contents: `
      export { registerPublishWindow, hasOpenPublishWindow, hasAnyOpenPublishWindow, afterPublishWindowClosed,
        TOUTIAO_DRAFT_WINDOW_NOTICE } from "./src/main/services/publishWindowRegistry.js";
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
  const replies = [];
  await tools.replyPublishFailure({
    page: null, data: draft, window: failedWindow,
    event: { reply: (_channel, payload) => replies.push(payload) },
    message: "文章标题未写入",
  });
  assert.strictEqual(failedWindow.isDestroyed(), false);
  assert.ok(failedWindow.shown && failedWindow.focused);
  assert.match(replies[0].message, /文章标题未写入.*窗口已保留/u);
  assert.throws(() => accounts.assertNoOpenWindow("a"), error => error.code === "account-window-open");
  assert.throws(() => accounts.assertIdle("a"), error => error.code === "account-window-open");
  assert.doesNotThrow(() => accounts.assertNoOpenWindow("b"));
  assert.doesNotThrow(() => accounts.assertIdle("b"));
  await assert.rejects(accounts.openLogin({ id: "a" }), error => error.code === "account-window-open");
  await assert.rejects(accounts.openDashboard({ id: "a" }), error => error.code === "account-window-open");
  await assert.rejects(accounts.remove({ id: "a" }), error => error.code === "account-window-open");
  failedWindow.close();
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
    const onShutdown = new FakeWindow();
    tools.registerPublishWindow(tt.partition, onShutdown);
    await service.dispose();
    assert.strictEqual(onShutdown.isDestroyed(), true);
    assert.strictEqual(tools.hasOpenPublishWindow(tt.partition), false);
  } finally {
    fs.rmSync(serviceRoot, { recursive: true, force: true });
  }

  const successWindow = new FakeWindow();
  tools.registerPublishWindow(partitionA, successWindow);
  const successReplies = [];
  await tools.replyPublishOutcome({
    page: { url: () => "https://mp.toutiao.com/profile_v4/manage/draft", waitForTimeout: async () => {} },
    data: draft, window: successWindow,
    event: { reply: (_channel, payload) => successReplies.push(payload) },
    isDraftMode: true, waitMs: 0,
  });
  assert.strictEqual(successReplies[0].status, true);
  assert.match(successReplies[0].message, /窗口已保留/u);
  assert.strictEqual(successWindow.isDestroyed(), false);
  assert.strictEqual(tools.hasOpenPublishWindow(partitionA), true);
  successWindow.close();
  assert.strictEqual(tools.hasOpenPublishWindow(partitionA), false);

  const directPublishWindow = new FakeWindow();
  tools.registerPublishWindow(partitionA, directPublishWindow);
  await tools.replyPublishOutcome({
    page: { url: () => "https://mp.toutiao.com/profile_v4/manage/article", waitForTimeout: async () => {} },
    data: { ...draft, publishToDraft: false }, window: directPublishWindow,
    event: { reply() {} }, isDraftMode: false, waitMs: 0,
  });
  assert.strictEqual(directPublishWindow.isDestroyed(), true, "direct publish keeps its existing close behavior");

  // Worker timeout keeps the visible draft page; Worker shutdown closes it.
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
    "Toutiao article draft must not schedule a four-hour auto-close");
  tools.cancelPuppeteerTasks("内容提交超时，已停止浏览器任务");
  assert.strictEqual(timeoutWindow.isDestroyed(), false);
  assert.ok(timeoutWindow.shown > 0);
  assert.strictEqual(tools.hasOpenPublishWindow(partitionA), true);
  assert.match(timeoutReplies.at(-1).message, /窗口已保留/u);
  await tools.replyPublishOutcome({
    page: { url: () => payload.url, waitForTimeout: async () => {} },
    data: payload, window: timeoutWindow, event: { reply() {} },
    isDraftMode: true, waitMs: 0,
  });
  assert.strictEqual(timeoutWindow.isDestroyed(), false, "late success must not close a retained window");
  timeoutWindow.close();
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
