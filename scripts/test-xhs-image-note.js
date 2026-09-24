"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { build } = require("esbuild");

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-image-note-test-"));
  try {
    const bundle = path.join(temporary, "article.cjs");
    await build({
      entryPoints: [path.join(__dirname, "../src/main/publisher-worker/article.js")],
      bundle: true, platform: "node", format: "cjs", outfile: bundle,
      plugins: [{
        name: "headless-worker-task",
        setup(build) {
          build.onResolve({ filter: /services\/puppeteerFile$/u }, () => ({ path: "task", namespace: "test" }));
          build.onLoad({ filter: /.*/u, namespace: "test" }, () => ({ contents:
            "export const runPuppeteerTask = (...args) => globalThis.__xhsTask(...args); export const cancelPuppeteerTasks = () => {};",
          }));
        },
      }],
    });
    const { runXhsImageNote } = require(bundle);
    const snapshotDirectory = path.join(temporary, "snapshot");
    fs.mkdirSync(path.join(snapshotDirectory, "assets"), { recursive: true });
    const assets = [
      { id: "11111111-1111-4111-8111-111111111111", mime: "image/png", bytes: Buffer.from("png fixture") },
      { id: "22222222-2222-4222-8222-222222222222", mime: "image/jpeg", bytes: Buffer.from("jpeg fixture") },
      { id: "33333333-3333-4333-8333-333333333333", mime: "image/webp", bytes: Buffer.from("webp fixture") },
    ];
    for (const asset of assets) fs.writeFileSync(path.join(snapshotDirectory, "assets", asset.id), asset.bytes);
    const manifest = { title: "图文测试", body: "正文", tags: [], creativeStatement: "none", assets };
    const account = { platform: "xhs", pt: "小红书", id: "test-account", partition: "persist:test" };
    for (const mode of ["draft", "publish"]) {
      for (const status of [true, false]) {
        let task;
        let transport;
        let finish;
        global.__xhsTask = (payload, event, onFinish) => { task = payload; transport = event; finish = onFinish; };
        const pending = runXhsImageNote(account, { snapshotDirectory, mode }, manifest);
        assert.ok(task);
        assert.strictEqual(task.publishToDraft, mode === "draft");
        assert.strictEqual(task.partition, account.partition);
        assert.strictEqual(task.publishOptions.maxAttempts, 1);
        assert.deepStrictEqual(task.imagePaths.map(file => path.extname(file)), [".png", ".jpg", ".webp"]);
        for (let i = 0; i < assets.length; i += 1) {
          assert.deepStrictEqual(fs.readFileSync(task.imagePaths[i]), assets[i].bytes);
          assert.notStrictEqual(task.imagePaths[i], path.join(snapshotDirectory, "assets", assets[i].id));
        }
        transport.reply("puppeteerFile-done", { taskId: task.taskId, status, message: "真实平台结果" });
        finish();
        const result = await pending;
        assert.strictEqual(result.exitCode, status ? 0 : 1);
        assert.strictEqual(result.message, "真实平台结果");
        assert.ok(!fs.existsSync(path.dirname(task.imagePaths[0])), "成功和失败均清理临时图片");
        for (const asset of assets) assert.deepStrictEqual(fs.readFileSync(path.join(snapshotDirectory, "assets", asset.id)), asset.bytes);
      }
    }
    let paths;
    global.__xhsTask = payload => { paths = payload.imagePaths; throw new Error("浏览器任务启动失败"); };
    assert.strictEqual((await runXhsImageNote(account, { snapshotDirectory, mode: "draft" }, manifest)).message, "浏览器任务启动失败");
    assert.ok(!fs.existsSync(path.dirname(paths[0])));
    global.__xhsTask = () => assert.fail("不支持的图片不能启动浏览器任务");
    await assert.rejects(runXhsImageNote(account, { snapshotDirectory, mode: "draft" }, {
      ...manifest, assets: [{ ...assets[0], mime: "image/gif" }],
    }), /不支持的图文图片格式/u);
    console.log("test-xhs-image-note passed");
  } finally {
    delete global.__xhsTask;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
