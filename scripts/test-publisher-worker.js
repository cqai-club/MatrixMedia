"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const root = path.join(__dirname, "..");

(async () => {
  const workerEntry = fs.readFileSync(path.join(root, "src/main/publisher-worker/index.js"), "utf8");
  assert.match(workerEntry, /app\.on\("window-all-closed",\s*\(\)\s*=>/u);
  const protocol = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/protocol.js")));
  const storeModule = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/store.js")));
  const capabilities = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/capabilities.js")));
  const packages = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/content-package.js")));
  assert.deepStrictEqual(capabilities.platformCapabilities({}).find(item => item.platform === "juejin").contentTypes, []);
  assert.deepStrictEqual(capabilities.platformCapabilities({ EBAO_PUBLISHER_EXPERIMENTAL_CAPABILITIES: "juejin:article" }).find(item => item.platform === "juejin").modes.article, ["publish", "draft"]);
  assert.strictEqual(capabilities.platformCapabilities({ EBAO_PUBLISHER_EXPERIMENTAL_CAPABILITIES: "juejin:article" }).find(item => item.platform === "juejin").maxAssets.article, 1);
  assert.deepStrictEqual(capabilities.platformCapabilities({ EBAO_PUBLISHER_EXPERIMENTAL_CAPABILITIES: "xhs:image-note" }).find(item => item.platform === "xhs").modes["image-note"], ["publish", "draft"]);
  assert.strictEqual(capabilities.platformCapabilities({ EBAO_PUBLISHER_EXPERIMENTAL_CAPABILITIES: "xhs:image-note" }).find(item => item.platform === "xhs").maxTitleLength["image-note"], 20);
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
    store.updateSubmission(submission.id, { state: "running" });
    const restored = new storeModule.PublisherStore(temporary);
    restored.recoverInterrupted();
    assert.strictEqual(restored.submission(submission.id).state, "unknown");
    assert.strictEqual(restored.listSubmissions()[0].targets[0].accountName, "测试账号");
    assert.ok(!Object.prototype.hasOwnProperty.call(restored.listSubmissions()[0], "state"));
    assert.ok(!Object.prototype.hasOwnProperty.call(restored.listSubmissions()[0], "file"));
    assert.strictEqual(restored.submissionsState.schemaVersion, 2);

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
    const checked = packages.readContentPackage(source, contentId, 3, "article");
    const snapshotId = "33333333-3333-4333-8333-333333333333";
    const snapshot = packages.captureContentPackage(checked, path.join(temporary, "snapshots"), snapshotId);
    fs.rmSync(source, { recursive: true });
    assert.strictEqual(packages.readContentPackage(snapshot, contentId, 3, "article", false).manifest.body, "# 标题");
    assert.throws(() => packages.readContentPackage(snapshot, contentId, 4, "article", false), /修订不匹配/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log("test-publisher-worker passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
