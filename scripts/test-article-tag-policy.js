"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
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
      title: "测试文章", body: "正文", summary: "主稿摘要", tags: ["AI", "科技"],
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
    assert.strictEqual(Object.hasOwn(toutiao.data, "summary"), false);
    assert.strictEqual(toutiao.data.content, "正文");
    const { prepareTargetArticle, modeForPreparedContent } = await import(pathToFileURL(path.join(root,
      "src/main/publisher-worker/article-preparation.js")));
    const metadataOnly = prepareTargetArticle(manifest, "tt");
    assert.deepStrictEqual(metadataOnly.messages, [], "头条摘要和标签不应显示为修整信息");
    assert.strictEqual(modeForPreparedContent("publish", "article", []), "publish");
    const published = await adapters.runToutiaoArticle({ platform: "tt", pt: "头条", partition: "persist:test", id: "test" },
      { ...submission, mode: "publish" }, metadataOnly.content);
    assert.strictEqual(published.status, "success");
    const silentMetadata = globalThis.__articleTagPayloads.at(-1);
    assert.strictEqual(silentMetadata.publishToDraft, false);
    assert.strictEqual(Object.hasOwn(silentMetadata.data, "tags"), false);
    assert.strictEqual(Object.hasOwn(silentMetadata.data, "summary"), false);
    const imageId = "22222222-2222-4222-8222-222222222222";
    const withImage = { ...manifest, body: `开头\n\n![示意图](ebao-asset://${imageId})\n\n结尾`,
      coverAssetId: imageId, assets: [{ id: imageId, mime: "image/png", bytes: 100 }] };
    const prepared = prepareTargetArticle(withImage, "tt");
    assert.match(prepared.content.body, /开头[\s\S]*【待手动上传图片 1：示意图】[\s\S]*结尾/u);
    assert.strictEqual(modeForPreparedContent("publish", "article", [{ accountId: "test", messages: prepared.messages }]), "draft");
    await adapters.runToutiaoArticle({ platform: "tt", pt: "头条", partition: "persist:test", id: "test" },
      submission, prepared.content);
    const manual = globalThis.__articleTagPayloads.at(-1);
    assert.deepStrictEqual(manual.data.images, []);
    assert.strictEqual(manual.data.coverPath, "");
    assert.strictEqual(manual.data.content, prepared.content.body);
    assert.strictEqual(withImage.body.includes(`![示意图](ebao-asset://${imageId})`), true);
    assert.strictEqual(Object.hasOwn(baijiahao.data, "tags"), false);
    assert.strictEqual(baijiahao.data.summary, "主稿摘要");
    assert.strictEqual(juejin.data.tags, "AI 科技");
    assert.deepStrictEqual(bilibili.data.tags, ["AI", "科技"]);
    assert.deepStrictEqual(manifest.tags, ["AI", "科技"]);
    assert.strictEqual(manifest.summary, "主稿摘要");
  } finally {
    delete globalThis.__articleTagPayloads;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log("test-article-tag-policy passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
