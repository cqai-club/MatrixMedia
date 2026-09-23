"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { buildSync } = require("esbuild");
const { Keyboard } = require("puppeteer-core");

assert.strictEqual(typeof Keyboard.prototype.sendCharacter, "function");

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

      const saveIndicator = (label, listed) => {
        let atDashboard = false;
        return {
          goto: async url => {
            assert.strictEqual(url, "https://mp.toutiao.com/profile_v4/manage/draft");
            atDashboard = true;
          },
          waitForFunction: async (callback, _options, ...args) => {
            global.document = atDashboard
              ? { body: { innerText: listed ? "测试标题" : "暂无草稿" } }
              : { querySelectorAll: () => [{ textContent: label }] };
            const result = callback(...args);
            if (!result) throw new Error("not saved");
            return { jsonValue: async () => result, dispose: async () => {} };
          },
        };
      };
      assert.strictEqual((await tools.confirmToutiaoDraftAutosave(saveIndicator("草稿保存中...", false), "测试标题")).confirmed, false);
      assert.strictEqual((await tools.confirmToutiaoDraftAutosave(saveIndicator("保存失败", false), "测试标题")).reason, "头条页面提示草稿保存失败");
      assert.strictEqual((await tools.confirmToutiaoDraftAutosave(saveIndicator("草稿已保存", false), "测试标题")).confirmed, false);
      assert.strictEqual((await tools.confirmToutiaoDraftAutosave(saveIndicator("草稿已保存", true), "测试标题")).confirmed, true);
      const responses = new EventEmitter();
      const save = tools.observeToutiaoDraftSave(responses);
      responses.emit("response", { url: () => "https://mp.toutiao.com/mp/agw/article/publish?source=mp",
        request: () => ({ method: () => "POST" }), json: async () => ({ code: 7050, message: "private response" }) });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(save.error(), "头条草稿保存接口拒绝（错误码 7050）");
      assert.strictEqual((await tools.confirmToutiaoDraftAutosave(saveIndicator("草稿保存中...", false), "测试标题", 1, save.error)).reason,
        "头条草稿保存接口拒绝（错误码 7050）");
      responses.emit("response", { url: () => "https://mp.toutiao.com/mp/agw/article/publish",
        request: () => ({ method: () => "POST" }), json: async () => ({ code: 0 }) });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(save.error(), "");
      save.stop();
      assert.strictEqual(responses.listenerCount("response"), 0);

      const originalDataTransfer = global.DataTransfer;
      const originalClipboardEvent = global.ClipboardEvent;
      global.DataTransfer = class {
        values = {};
        setData(type, value) { this.values[type] = value; }
        getData(type) { return this.values[type]; }
      };
      global.ClipboardEvent = class {
        constructor(type, options) { this.type = type; this.clipboardData = options.clipboardData; }
      };
      const editorPage = ({ paste = false, command = false } = {}) => {
        const state = { html: "<p></p>", text: "", inserted: 0, pasteEvents: 0 };
        const element = {
          get innerHTML() { return state.html; },
          get textContent() { return state.text; },
          focus() {},
          querySelectorAll: () => [],
          dispatchEvent(event) {
            state.pasteEvents++;
            if (paste) {
              state.html = event.clipboardData.getData("text/html");
              state.text = event.clipboardData.getData("text/plain");
            }
          },
        };
        const page = {
          click: async () => {},
          evaluate: async (callback, ...args) => {
            global.document = {
              querySelector: () => element,
              execCommand: (_action, _show, html) => {
                if (command) { state.html = html; state.text = html.replace(/<[^>]+>/gu, ""); }
              },
            };
            return callback(...args);
          },
          waitForFunction: async (callback, _options, ...args) => {
            if (!callback(...args)) throw new Error("not written");
          },
          keyboard: { sendCharacter: async value => {
            state.inserted++;
            state.html = value;
            state.text = value;
          } },
        };
        return { page, state };
      };
      try {
        const synthetic = editorPage({ paste: true });
        await tools.pasteArticleHtml(synthetic.page, "#editor", "<p>Hello</p>", "Hello");
        assert.strictEqual(synthetic.state.inserted, 0);
        assert.strictEqual(synthetic.state.html, "<p>Hello</p>");
        const htmlCommand = editorPage({ command: true });
        await tools.pasteArticleHtml(htmlCommand.page, "#editor", "<h1>Title</h1>", "# Title");
        assert.strictEqual(htmlCommand.state.inserted, 0);
        const textFallback = editorPage();
        await tools.pasteArticleHtml(textFallback.page, "#editor", "<p>Plain</p>", "Plain");
        assert.strictEqual(textFallback.state.inserted, 1);
        const toutiaoPlain = editorPage({ paste: true });
        await tools.pasteArticleHtml(toutiaoPlain.page, "#editor", "<p>Plain</p>", "Plain", toutiaoPlain.page,
          [], { preferKeyboardForPlain: true });
        assert.strictEqual(toutiaoPlain.state.inserted, 1);
        assert.strictEqual(toutiaoPlain.state.pasteEvents, 0);
        const formattedFailure = editorPage();
        await assert.rejects(tools.pasteArticleHtml(formattedFailure.page, "#editor", "<h1>Title</h1>", "# Title"), /文章正文未写入/u);
        assert.strictEqual(formattedFailure.state.inserted, 0);
        const toutiaoRich = editorPage({ paste: true });
        await tools.pasteArticleHtml(toutiaoRich.page, "#editor", "<h1>Title</h1>", "# Title", toutiaoRich.page,
          [], { preferKeyboardForPlain: true });
        assert.strictEqual(toutiaoRich.state.inserted, 0);
        assert.strictEqual(toutiaoRich.state.pasteEvents, 1);

        const indicator = count => ({
          querySelectorAll: () => count === null ? [] : [{
            closest: () => null,
            getBoundingClientRect: () => ({ width: 20 }),
            textContent: `共 ${count} 字`,
          }],
        });
        const counterPage = count => ({
          waitForFunction: async callback => {
            global.document = indicator(count);
            if (!callback()) throw new Error("not accepted");
          },
          evaluate: async callback => {
            global.document = indicator(count);
            return callback();
          },
        });
        await tools.confirmToutiaoBodyAccepted(counterPage(12), 1);
        await assert.rejects(tools.confirmToutiaoBodyAccepted(counterPage(0), 1), /字数仍为 0/u);
        await assert.rejects(tools.confirmToutiaoBodyAccepted(counterPage(null), 1), /未获得平台字数确认/u);
      } finally {
        global.DataTransfer = originalDataTransfer;
        global.ClipboardEvent = originalClipboardEvent;
      }

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
