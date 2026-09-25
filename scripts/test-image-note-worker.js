"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { build } = require("esbuild");

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "image-note-worker-test-"));
  try {
    const outfile = path.join(temporary, "article.cjs");
    await build({
      entryPoints: [path.join(__dirname, "../src/main/publisher-worker/article.js")],
      bundle: true, platform: "node", format: "cjs", outfile,
      plugins: [{
        name: "headless-image-note-task",
        setup(builder) {
          builder.onResolve({ filter: /services\/puppeteerFile$/u }, () => ({ path: "task", namespace: "test" }));
          builder.onResolve({ filter: /services\/publishWindowRegistry\.js$/u }, () => ({ path: "windows", namespace: "test" }));
          builder.onLoad({ filter: /.*/u, namespace: "test" }, args => ({ contents: args.path === "task"
            ? "export const runPuppeteerTask = (...args) => globalThis.__imageTask(...args); export const cancelPuppeteerTasks = () => {};"
            : "export const hasOpenPublishWindow = () => globalThis.__imageWindowOpen === true; export const afterPublishWindowClosed = (_partition, fn) => { globalThis.__closeImageWindow = fn; };",
          }));
        },
      }],
    });
    const actions = require(outfile);
    const snapshotDirectory = path.join(temporary, "snapshot");
    fs.mkdirSync(path.join(snapshotDirectory, "assets"), { recursive: true });
    const assets = [
      { id: "11111111-1111-4111-8111-111111111111", mime: "image/jpeg" },
      { id: "22222222-2222-4222-8222-222222222222", mime: "image/png" },
    ];
    for (const asset of assets) fs.writeFileSync(path.join(snapshotDirectory, "assets", asset.id), asset.id);
    const manifest = { title: "图文标题", body: "图文正文", tags: ["旅行"], creativeStatement: "none", assets };
    const platforms = [
      ["ks", "快手", actions.runKuaishouImageNote, "tabType=2"],
      ["dy", "抖音", actions.runDouyinImageNote, "default-tab=3"],
    ];
    for (const [platform, pt, run, urlPart] of platforms) {
      const account = { platform, pt, partition: `persist:${platform}`, id: platform };
      let task;
      let reply;
      globalThis.__imageTask = (payload, event) => { task = payload; reply = event.reply; };
      const pending = run(account, { snapshotDirectory, mode: "draft" }, manifest);
      assert.strictEqual(task.textType, "image-note");
      assert.strictEqual(task.publishToDraft, true);
      assert.strictEqual(task.partition, account.partition);
      assert.ok(task.url.includes(urlPart));
      assert.deepStrictEqual(task.data, {
        title: manifest.title, description: manifest.body, tags: manifest.tags, creativeStatement: "none",
      });
      assert.deepStrictEqual(task.imagePaths.map(file => path.extname(file)), [".jpg", ".png"]);
      assert.deepStrictEqual(task.imagePaths.map(file => fs.readFileSync(file, "utf8")), assets.map(asset => asset.id));
      reply("puppeteerFile-done", { taskId: task.taskId, status: false, needsAttention: true, message: "草稿未确认" });
      assert.deepStrictEqual(await pending, { exitCode: 1, status: "unknown", message: "草稿未确认" });
      assert.ok(!fs.existsSync(path.dirname(task.imagePaths[0])));
      assert.throws(() => run(account, { snapshotDirectory, mode: "publish" }, manifest), /暂只支持转存草稿/u);
    }
    globalThis.__imageWindowOpen = true;
    let retainedTask;
    let retainedReply;
    globalThis.__imageTask = (payload, event) => { retainedTask = payload; retainedReply = event.reply; };
    const retained = actions.runKuaishouImageNote({ platform: "ks", pt: "快手", partition: "persist:ks", id: "ks" },
      { snapshotDirectory, mode: "draft" }, manifest);
    retainedReply("puppeteerFile-done", { taskId: retainedTask.taskId, status: false, needsAttention: true, message: "待核查" });
    assert.strictEqual((await retained).status, "unknown");
    assert.ok(fs.existsSync(retainedTask.imagePaths[0]), "留窗期间保持图片输入路径有效");
    globalThis.__closeImageWindow();
    assert.ok(!fs.existsSync(retainedTask.imagePaths[0]), "人工关窗后清理临时图片");
    console.log("test-image-note-worker passed");
  } finally {
    delete globalThis.__imageTask;
    delete globalThis.__imageWindowOpen;
    delete globalThis.__closeImageWindow;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
