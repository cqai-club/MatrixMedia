"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { build } = require("esbuild");

(async () => {
  const root = path.join(__dirname, "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ebao-article-tags-"));
  try {
    const outfile = path.join(temporary, "article.cjs");
    await build({
      entryPoints: [path.join(root, "src/main/publisher-worker/article.js")],
      bundle: true, platform: "node", format: "cjs", outfile,
      plugins: [{
        name: "capture-article-payload",
        setup(builder) {
          builder.onResolve({ filter: /^\.\.\/services\/puppeteerFile$/u }, () => ({
            path: "puppeteerFile", namespace: "article-tag-test",
          }));
          builder.onLoad({ filter: /.*/u, namespace: "article-tag-test" }, () => ({
            contents: `export function cancelPuppeteerTasks() {}
              export function runPuppeteerTask(payload, listener) {
                globalThis.__articleTagPayloads.push(payload);
                listener.reply("puppeteerFile-done", { taskId: payload.taskId, status: true });
              }`,
            loader: "js",
          }));
        },
      }],
    });
    const adapters = require(outfile);
    const manifest = {
      title: "测试文章", body: "正文", summary: "", tags: ["AI", "科技"],
      creativeStatement: "none", assets: [], platformFields: {},
    };
    const submission = { snapshotDirectory: temporary, mode: "draft" };
    const accounts = [
      { platform: "tt", pt: "头条", run: adapters.runToutiaoArticle },
      { platform: "bjh", pt: "百家号", run: adapters.runBaijiahaoArticle },
      { platform: "juejin", pt: "掘金", run: adapters.runJuejinArticle },
      { platform: "blbl", pt: "哔哩哔哩", run: adapters.runBilibiliArticle },
    ];
    globalThis.__articleTagPayloads = [];
    for (const account of accounts) {
      const result = await account.run({ ...account, partition: "persist:test", id: "test" }, submission, manifest);
      assert.strictEqual(result.status, "draft");
    }
    const [toutiao, baijiahao, juejin, bilibili] = globalThis.__articleTagPayloads;
    assert.strictEqual(Object.hasOwn(toutiao.data, "tags"), false);
    assert.strictEqual(Object.hasOwn(baijiahao.data, "tags"), false);
    assert.strictEqual(juejin.data.tags, "AI 科技");
    assert.deepStrictEqual(bilibili.data.tags, ["AI", "科技"]);
    assert.deepStrictEqual(manifest.tags, ["AI", "科技"]);
  } finally {
    delete globalThis.__articleTagPayloads;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log("test-article-tag-policy passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
