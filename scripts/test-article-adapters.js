"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ebao-article-adapter-test-"));
const bundleDir = path.join(root, "test/.cache");
fs.mkdirSync(bundleDir, { recursive: true });
try {
  for (const name of ["articleWebTools", "articleImageUpload"]) {
    buildSync({
      entryPoints: [path.join(root, `src/main/services/upLoad/${name}.js`)],
      bundle: true, platform: "node", format: "cjs",
      outfile: path.join(bundleDir, `${name}.cjs`), external: ["electron"],
    });
  }
  const tools = require(path.join(bundleDir, "articleWebTools.cjs"));
  const upload = require(path.join(bundleDir, "articleImageUpload.cjs"));
  const pageAt = (url, notices = []) => ({
    waitForFunction: async (callback, _options, ...args) => {
      global.location = { href: url };
      global.document = {
        querySelectorAll: () => notices.map(text => ({
          getBoundingClientRect: () => ({ width: 20, height: 20 }), textContent: text,
        })),
      };
      if (!callback(...args)) throw new Error("no confirmation");
    },
    url: () => url,
    isClosed: () => true,
  });

  (async () => {
    try {
      const before = "https://mp.toutiao.com/profile_v4/graphic/publish";
      assert.strictEqual(await tools.confirmPlatformOutcome(pageAt(before), "draft", before), false);
      assert.strictEqual(await tools.confirmPlatformOutcome(pageAt(before, ["图片保存成功"]), "draft", before, ["图片保存成功"]), false);
      assert.strictEqual(await tools.confirmPlatformOutcome(pageAt(before, ["草稿已保存"]), "draft", before), true);
      assert.strictEqual(await tools.confirmPlatformOutcome(pageAt(before, ["草稿已保存"]), "publish", before), false);
      assert.strictEqual(await tools.confirmPlatformOutcome(pageAt("https://mp.toutiao.com/profile_v4/graphic/success"), "publish", before), true);
      assert.strictEqual(await tools.confirmPlatformOutcome(pageAt("https://mp.toutiao.com/profile_v4/graphic/edit?article_id=1"), "publish", before), false);

      const calls = [];
      await tools.finishArticle(pageAt(before), { pt: "头条", closeWindowAfterPublish: false }, null,
        { reply: (_channel, payload) => calls.push(payload) }, "publish", before, false);
      assert.strictEqual(calls[0].status, false);
      assert.strictEqual(calls[0].publishAbnormal, true);
      assert.strictEqual(calls[0].needsAttention, true);

      const image = path.join(temporary, "test.png");
      fs.writeFileSync(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
      await assert.rejects(upload.uploadBaijiahaoImage({ evaluate: async () => ({ errmsg: "invalid" }) },
        { path: image, mime: "image/png" }), /图片上传失败/u);
      await assert.rejects(upload.uploadBaijiahaoImage({ evaluate: async () => ({ errno: 1, errmsg: "success", ret: { https_url: "https://example.com/a.png" } }) },
        { path: image, mime: "image/png" }), /图片上传失败/u);
      console.log("test-article-adapters passed");
    } finally {
      delete global.document;
      delete global.location;
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} catch (error) {
  fs.rmSync(temporary, { recursive: true, force: true });
  throw error;
}
