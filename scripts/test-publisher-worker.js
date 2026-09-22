"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const root = path.join(__dirname, "..");

(async () => {
  const protocol = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/protocol.js")));
  const storeModule = await import(pathToFileURL(path.join(root, "src/main/publisher-worker/store.js")));
  const frames = [];
  const errors = [];
  const decode = protocol.createFrameDecoder(frame => frames.push(frame), error => errors.push(error));
  decode(Buffer.from('{"id":"1","method":"system.'));
  decode(Buffer.from('health"}\n{"id":"2","method":"accounts.list"}\n'));
  assert.deepStrictEqual(frames.map(frame => frame.id), ["1", "2"]);
  assert.strictEqual(errors.length, 0);
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
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log("test-publisher-worker passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
