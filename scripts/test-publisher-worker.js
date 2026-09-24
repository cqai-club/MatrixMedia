"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { createHash } = require("crypto");
const vm = require("vm");

const root = path.join(__dirname, "..");

(async () => {
  const workerEntry = fs.readFileSync(path.join(root, "src/main/publisher-worker/index.js"), "utf8");
  assert.match(workerEntry, /app\.on\("window-all-closed",\s*\(\)\s*=>/u);
  assert.match(workerEntry, /"submissions\.delete": params => service\.deleteSubmission\(params\)/u);
  const protocol = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/protocol.js")));
  const storeModule = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/store.js")));
  const accountNames = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/account-name.js")));
  assert.strictEqual(accountNames.normalizeAccountName("  抖音创作者  "), "抖音创作者");
  assert.strictEqual(accountNames.normalizeAccountName("登录"), null);
  assert.strictEqual(accountNames.normalizeAccountName("a".repeat(101)), null);
  const domName = vm.runInNewContext(accountNames.profileNameScript("抖音"), {
    document: { querySelectorAll: () => [{ getClientRects: () => [1], textContent: "已登录账号" }] },
  });
  assert.strictEqual(accountNames.normalizeAccountName(domName), "已登录账号");
  const apiName = await vm.runInNewContext(accountNames.DOUYIN_PROFILE_SCRIPT, {
    AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      assert.strictEqual(url, "/aweme/v1/creator/user/info/");
      assert.strictEqual(options.credentials, "same-origin");
      return { ok: true, json: async () => ({ status_code: 0, douyin_user_verify_info: { nick_name: "抖音昵称" } }) };
    },
  });
  assert.strictEqual(apiName, "抖音昵称");
  const capabilities = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/capabilities.js")));
  const packages = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/content-package.js")));
  const articles = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/article-content.js")));
  const routing = await import(pathToFileURL(path.join(root, "src/main/services/upLoad/taskRouting.js")));
  const { publisherUserAgent } = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/userAgent.js")));
  const configured = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/138.0.0.0";
  assert.strictEqual(publisherUserAgent("抖音", configured, "150.0.7871.212", "darwin"), configured);
  assert.strictEqual(publisherUserAgent("头条", configured, "", "darwin"), configured);
  assert.match(publisherUserAgent("头条", configured, "150.0.7871.212", "darwin"), /Macintosh.*Chrome\/150\.0\.0\.0/u);
  assert.match(publisherUserAgent("头条", configured, "150.0.7871.212", "win32"), /Windows NT.*Chrome\/150\.0\.0\.0/u);
  assert.match(fs.readFileSync(path.join(root, "src/main/publisher-worker/article.js"), "utf8"), /graphic\/publish\?from=toutiao_pc/u);
  const advertised = capabilities.platformCapabilities();
  assert.deepStrictEqual(advertised.find(item => item.platform === "juejin").modes.article, ["publish", "draft"]);
  assert.strictEqual(advertised.find(item => item.platform === "juejin").maxAssets.article, 1);
  assert.deepStrictEqual(advertised.find(item => item.platform === "blbl").modes.article, ["publish", "draft"]);
  assert.deepStrictEqual(advertised.find(item => item.platform === "xhs").modes["image-note"], ["publish", "draft"]);
  assert.strictEqual(advertised.find(item => item.platform === "xhs").maxTitleLength["image-note"], 20);
  for (const platform of ["tt", "bjh"]) {
    const entry = advertised.find(item => item.platform === platform);
    assert.deepStrictEqual(entry.contentTypes, ["video", "article"]);
    assert.deepStrictEqual(entry.modes.article, ["publish", "draft"]);
    assert.strictEqual(capabilities.accepts(advertised, platform, "article", "draft"), true);
    assert.strictEqual(capabilities.accepts(advertised, platform, "article", "publish"), true);
  }
  assert.strictEqual(capabilities.accepts(advertised, "dy", "article", "draft"), false);
  assert.strictEqual(capabilities.accepts(advertised, "bjh", "image-note", "publish"), false);
  assert.strictEqual(routing.publisherHandlerKey({ pt: "头条", textType: "article", publishToDraft: true }), "article:tt:draft");
  assert.strictEqual(routing.publisherHandlerKey({ pt: "百家号", textType: "article" }), "article:bjh:publish");
  assert.strictEqual(routing.publisherHandlerKey({ pt: "头条", textType: "local" }), "legacy:头条");
  assert.strictEqual(routing.publisherHandlerKey({ pt: "抖音", textType: "article" }), "");
  assert.strictEqual(routing.publisherHandlerKey({ pt: "小红书", textType: "image-note" }), "image-note:xhs:publish");
  assert.strictEqual(routing.usesManualToutiaoArticleWindow({ publisherWorker: true, pt: "头条", textType: "article", publishToDraft: true }), true);
  assert.strictEqual(routing.usesManualToutiaoArticleWindow({ publisherWorker: true, pt: "头条", textType: "article", publishToDraft: false }), false);
  assert.strictEqual(routing.usesManualToutiaoArticleWindow({ publisherWorker: true, pt: "头条", textType: "local", publishToDraft: true }), false);
  assert.strictEqual(routing.usesManualToutiaoArticleWindow({ publisherWorker: true, pt: "百家号", textType: "article", publishToDraft: true }), false);
  assert.strictEqual(routing.usesManualToutiaoArticleWindow({ publisherWorker: false, pt: "头条", textType: "article", publishToDraft: true }), false);
  const frames = [];
  const errors = [];
  const decode = protocol.createFrameDecoder(frame => frames.push(frame), error => errors.push(error));
  decode(Buffer.from('{"id":"1","method":"system.'));
  decode(Buffer.from('health"}\n{"id":"2","method":"accounts.list"}\n'));
  assert.deepStrictEqual(frames.map(frame => frame.id), ["1", "2"]);
  assert.strictEqual(errors.length, 0);
  const utf8 = Buffer.from('{"id":"3","method":"测试"}\n');
  const splitAt = utf8.indexOf(Buffer.from("测")[0]);
  decode(utf8.subarray(0, splitAt + 1));
  decode(utf8.subarray(splitAt + 1));
  assert.strictEqual(frames[2].method, "测试");
  decode(Buffer.from("not-json\n"));
  assert.strictEqual(errors.at(-1).code, "invalid-json");
  decode(Buffer.from(`${"x".repeat(protocol.MAX_FRAME_BYTES + 1)}\n`));
  assert.strictEqual(errors.at(-1).code, "frame-too-large");

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "matrixmedia-worker-"));
  try {
    const store = new storeModule.PublisherStore(temporary);
    const account = store.addAccount({ displayName: "测试账号", platform: "dy", pt: "抖音" });
    assert.ok(account.id);
    assert.ok(account.partition.startsWith("persist:ebao_"));
    assert.ok(!account.partition.includes("-"));
    assert.ok(!Object.prototype.hasOwnProperty.call(store.listAccounts()[0], "partition"));
    assert.ok(!Object.prototype.hasOwnProperty.call(store.listAccounts()[0], "proxy"));
    const originalPartition = account.partition;
    const submission = store.createSubmission({
      workId: "work-1", file: "/tmp/video.mp4", title: "标题", mode: "publish",
    }, [account]);
    assert.strictEqual(store.listSubmissions()[0].contentType, "video");
    assert.strictEqual(store.listSubmissions()[0].contentId, "work-1");
    store.updateAccount(account.id, { displayName: "已改名" });
    assert.strictEqual(store.account(account.id).partition, originalPartition);
    const second = store.addAccount({ displayName: "第二账号", platform: "dy", pt: "抖音" });
    assert.notStrictEqual(second.partition, account.partition);
    const pending = store.addAccount({ displayName: "待识别的抖音账号", platform: "dy", pt: "抖音", autoName: true });
    assert.strictEqual(store.account(pending.id).autoName, true);
    store.updateAccount(pending.id, { displayName: "平台昵称", autoName: false });
    assert.strictEqual(store.account(pending.id).autoName, false);
    store.updateSubmission(submission.id, { state: "running" });
    const restored = new storeModule.PublisherStore(temporary);
    restored.recoverInterrupted();
    assert.strictEqual(restored.submission(submission.id).state, "unknown");
    assert.strictEqual(restored.listSubmissions()[0].targets[0].accountName, "测试账号");
    assert.strictEqual(restored.listSubmissions()[0].state, "unknown");
    assert.strictEqual(restored.listSubmissions()[0].message, "上次运行被中断，未自动重试，请到平台后台确认");
    assert.ok(!Object.prototype.hasOwnProperty.call(restored.listSubmissions()[0], "file"));
    assert.strictEqual(restored.submissionsState.schemaVersion, 2);
    assert.throws(() => restored.deleteFinishedSubmission(submission.id), error => error.code === "submission-unknown");
    assert.throws(() => restored.deleteFinishedSubmission(submission.id, false), error => error.code === "submission-unknown");
    assert.ok(new storeModule.PublisherStore(temporary).submission(submission.id));
    const uncertain = restored.createSubmission({ workId: "work-unknown", file: "/tmp/video-unknown.mp4", title: "结果待确认", mode: "draft" }, [account]);
    restored.updateSubmission(uncertain.id, { state: "unknown", result: { results: [
      { status: "unknown", message: `头条草稿保存未确认\n${"待核对".repeat(80)}` },
    ] } });
    const publicUncertain = restored.listSubmissions().find(item => item.id === uncertain.id);
    assert.strictEqual(publicUncertain.state, "unknown");
    assert.ok(publicUncertain.message.startsWith("头条草稿保存未确认 待核对"));
    assert.strictEqual(publicUncertain.message.length, 200);
    assert.ok(!Object.prototype.hasOwnProperty.call(publicUncertain, "result"));
    assert.strictEqual(restored.deleteFinishedSubmission(uncertain.id, true).id, uncertain.id);
    assert.strictEqual(new storeModule.PublisherStore(temporary).submission(uncertain.id), undefined);
    const removable = restored.createSubmission({ workId: "work-2", file: "/tmp/video-2.mp4", title: "可删除", mode: "draft" }, [account]);
    assert.throws(() => restored.deleteFinishedSubmission(removable.id), error => error.code === "submission-busy");
    assert.throws(() => restored.deleteFinishedSubmission(removable.id, true), error => error.code === "submission-busy");
    assert.ok(restored.queued().some(item => item.id === removable.id));
    restored.updateSubmission(removable.id, { state: "running" });
    assert.throws(() => restored.deleteFinishedSubmission(removable.id), error => error.code === "submission-busy");
    assert.throws(() => restored.deleteFinishedSubmission(removable.id, true), error => error.code === "submission-busy");
    assert.strictEqual(restored.submission(removable.id).state, "running");
    restored.updateSubmission(removable.id, { state: "completed" });
    assert.strictEqual(restored.deleteFinishedSubmission(removable.id).id, removable.id);
    assert.strictEqual(new storeModule.PublisherStore(temporary).submission(removable.id), undefined);
    assert.ok(new storeModule.PublisherStore(temporary).submission(submission.id));
    assert.throws(() => restored.deleteFinishedSubmission(removable.id), error => error.code === "submission-not-found");
    const failed = restored.createSubmission({ workId: "work-3", file: "/tmp/video-3.mp4", title: "失败", mode: "publish" }, [account]);
    restored.updateSubmission(failed.id, { state: "failed" });
    assert.strictEqual(restored.deleteFinishedSubmission(failed.id).id, failed.id);
    assert.strictEqual(restored.deleteFinishedSubmission(submission.id, true).id, submission.id);
    assert.strictEqual(new storeModule.PublisherStore(temporary).submission(submission.id), undefined);

    const legacyDir = path.join(temporary, "legacy");
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(path.join(legacyDir, "submissions.json"), JSON.stringify({
      schemaVersion: 1,
      submissions: [{ id: "legacy", workId: "old-work", createdAt: "2026-01-01T00:00:00Z", title: "旧视频", mode: "draft", state: "completed", targets: [] }],
    }));
    const migrated = new storeModule.PublisherStore(legacyDir);
    assert.strictEqual(migrated.submissionsState.schemaVersion, 2);
    assert.deepStrictEqual(migrated.listSubmissions()[0].contentType, "video");
    assert.deepStrictEqual(migrated.listSubmissions()[0].contentId, "old-work");

    const contentId = "11111111-1111-4111-8111-111111111111";
    const source = path.join(temporary, "contents", contentId);
    fs.mkdirSync(path.join(source, "assets"), { recursive: true });
    const assetId = "22222222-2222-4222-8222-222222222222";
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    fs.writeFileSync(path.join(source, "assets", assetId), png);
    const manifest = {
      id: contentId, contentType: "article", revision: 3, title: "文章",
      body: "# 标题", summary: "", tags: [], creativeStatement: "none",
      assets: [{ id: assetId, mime: "image/png", bytes: png.length }],
      coverAssetId: assetId, platformFields: { juejin: { category: "前端" } },
    };
    fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify(manifest));
    const managedBody = `正文\n\n![图](ebao-asset://${assetId})`;
    assert.deepStrictEqual(articles.articleImageIds({ ...manifest, body: managedBody }), [assetId]);
    assert.match(articles.renderArticleHtml({ ...manifest, body: managedBody }, { [assetId]: "https://example.com/image.png" }), /<img src="https:\/\/example.com\/image.png"/u);
    assert.throws(() => articles.renderArticleHtml({ ...manifest, body: managedBody }, {}), /上传未完成/u);
    assert.throws(() => articles.articleImageIds({ ...manifest, body: "![外部](https://example.com/a.png)" }), /必须引用/u);
    assert.throws(() => articles.articleImageIds({ ...manifest, body: "![本地](../image.png)" }), /必须引用/u);
    assert.throws(() => articles.articleImageIds({ ...manifest, body: "<img src='file:///tmp/a'>" }), /原始 HTML/u);
    assert.throws(() => articles.articleImageIds({ ...manifest, body: "![错误](ebao-asset://33333333-3333-4333-8333-333333333333)" }), /必须引用/u);
    const checked = packages.readContentPackage(source, contentId, 3, "article");
    const snapshotId = "33333333-3333-4333-8333-333333333333";
    const snapshot = packages.captureContentPackage(checked, path.join(temporary, "snapshots"), snapshotId);
    fs.rmSync(source, { recursive: true });
    assert.strictEqual(packages.readContentPackage(snapshot, contentId, 3, "article", false).manifest.body, "# 标题");
    assert.throws(() => packages.readContentPackage(snapshot, contentId, 4, "article", false), /修订不匹配/u);
    const changedManifest = { ...manifest, assets: [{ ...manifest.assets[0], sha256: createHash("sha256").update(png).digest("hex") }] };
    fs.writeFileSync(path.join(snapshot, "manifest.json"), JSON.stringify(changedManifest));
    fs.writeFileSync(path.join(snapshot, "assets", assetId), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]));
    assert.throws(() => packages.readContentPackage(snapshot, contentId, 3, "article", false), /素材已改变/u);
    const snapshotsRoot = path.join(temporary, "snapshots");
    const outside = path.join(temporary, "outside-snapshot");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep"), "safe");
    assert.strictEqual(packages.removeSubmissionSnapshot(snapshotsRoot, { id: snapshotId, snapshotDirectory: outside }), false);
    assert.strictEqual(fs.existsSync(path.join(outside, "keep")), true);
    const linkedId = "44444444-4444-4444-8444-444444444444";
    const linkedSnapshot = path.join(snapshotsRoot, linkedId);
    fs.symlinkSync(outside, linkedSnapshot, "dir");
    assert.strictEqual(packages.removeSubmissionSnapshot(snapshotsRoot, { id: linkedId, snapshotDirectory: linkedSnapshot }), false);
    assert.strictEqual(fs.existsSync(path.join(outside, "keep")), true);
    assert.strictEqual(packages.removeSubmissionSnapshot(snapshotsRoot, { id: snapshotId, snapshotDirectory: snapshot }), true);
    assert.strictEqual(fs.existsSync(snapshot), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log("test-publisher-worker passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
