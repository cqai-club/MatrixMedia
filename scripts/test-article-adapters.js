"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { build, buildSync } = require("esbuild");
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
  buildSync({
    entryPoints: [path.join(root, "src/main/services/upLoad/blblArticle.js")],
    bundle: true, platform: "node", format: "cjs",
    outfile: path.join(bundleDir, "blblArticle-test.cjs"), external: ["electron"],
  });
  const { markdownToArticleHtml } = require(path.join(bundleDir, "blblArticle-test.cjs"));
  const formatted = markdownToArticleHtml("# 标题\n\n**重点**与[链接](https://example.com/a?x=1&y=2)\n\n- 第一项\n- 第二项\n\n> 引用");
  assert.match(formatted, /<h1>标题<\/h1>/u);
  assert.match(formatted, /<strong>重点<\/strong>/u);
  assert.match(formatted, /<a href="https:\/\/example\.com\/a\?x=1&amp;y=2">链接<\/a>/u);
  assert.match(formatted, /<ul>[\s\S]*<li>第一项<\/li>[\s\S]*<li>第二项<\/li>[\s\S]*<\/ul>/u);
  assert.match(formatted, /<blockquote>[\s\S]*引用[\s\S]*<\/blockquote>/u);
  assert.doesNotMatch(formatted, /\*\*重点\*\*|\[链接\]|^- 第一项/mu);
  assert.match(markdownToArticleHtml("<script>alert(1)</script>"), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(markdownToArticleHtml("[危险](javascript:alert(1))"), /href=/u);
  assert.throws(() => markdownToArticleHtml("![正文图](https://example.com/image.png)"), /暂不支持正文插图/u);
  const webExports = [
    "captureArticleNotices", "clickArticleAction", "confirmPlatformOutcome", "currentUrl", "failArticle",
    "confirmToutiaoBodyAccepted", "confirmToutiaoDraftAutosave", "confirmToutiaoInitialDraftAutosave",
    "fillArticleMetadata", "fillArticleTitle", "findArticleEditor", "finishArticle",
    "observeToutiaoDraftSave", "pasteArticleHtml", "renderUploadedArticle",
  ];
  const imageExports = ["selectToutiaoCover", "uploadToutiaoImage"];
  const toutiaoAdapterBuild = {
    entryPoints: [path.join(root, "src/main/services/upLoad/ttArticle.js")],
    bundle: true, platform: "node", format: "cjs",
    outfile: path.join(bundleDir, "ttArticle-test.cjs"),
    plugins: [{
      name: "mock-toutiao-adapter-dependencies",
      setup(build) {
        build.onResolve({ filter: /^\.\/article(?:WebTools|ImageUpload)\.js$/u }, args => ({
          path: args.path.includes("WebTools") ? "web" : "image", namespace: "tt-article-test",
        }));
        build.onLoad({ filter: /.*/u, namespace: "tt-article-test" }, args => ({
          contents: (args.path === "web" ? webExports : imageExports)
            .map(name => `export const ${name} = (...args) => globalThis.__ttAdapterMocks.${name}(...args);`)
            .join("\n"),
          loader: "js",
        }));
      },
    }],
  };
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
      await build(toutiaoAdapterBuild);
      const publishToutiaoArticle = require(path.join(bundleDir, "ttArticle-test.cjs")).default;
      const before = "https://mp.toutiao.com/profile_v4/graphic/publish";
      assert.strictEqual(await tools.confirmPlatformOutcome(pageAt(before), "draft", before), false);
      assert.strictEqual(await tools.confirmPlatformOutcome(pageAt(before, ["图片保存成功"]), "draft", before, ["图片保存成功"]), false);
      assert.strictEqual(await tools.confirmPlatformOutcome(pageAt(before, ["草稿已保存"]), "draft", before), true);
      assert.strictEqual(await tools.confirmPlatformOutcome(pageAt(before, ["草稿已保存"]), "publish", before), false);
      assert.strictEqual(await tools.confirmPlatformOutcome(pageAt("https://mp.toutiao.com/profile_v4/graphic/success"), "publish", before), true);
      assert.strictEqual(await tools.confirmPlatformOutcome(pageAt("https://mp.toutiao.com/profile_v4/graphic/edit?article_id=1"), "publish", before), false);

      const draftList = listed => {
        let atDashboard = false;
        return {
          goto: async url => {
            assert.strictEqual(url, "https://mp.toutiao.com/profile_v4/manage/draft");
            atDashboard = true;
          },
          waitForFunction: async (callback, _options, ...args) => {
            global.document = atDashboard ? { body: { innerText: listed ? "测试标题" : "暂无草稿" } } : {};
            const result = callback(...args);
            if (!result) throw new Error("not saved");
          },
        };
      };
      const saveResponse = (content, code, { title = "测试标题", pgcId = "", url = "https://mp.toutiao.com/mp/agw/article/publish?source=mp" } = {}) => ({
        url: () => url,
        status: () => 200,
        request: () => ({ url: () => url, method: () => "POST", postData: () => new URLSearchParams({
          title, content, ...(pgcId ? { pgc_id: pgcId } : {}),
        }).toString() }),
        json: async () => ({ code, message: "private response" }),
      });
      const saveRequest = ({
        title = "测试标题", content = "", url = "https://mp.toutiao.com/mp/agw/article/publish?token=private",
        failure = null,
      } = {}) => ({
        url: () => url,
        method: () => "POST",
        postData: () => new URLSearchParams({ title, content }).toString(),
        failure: () => failure && { errorText: failure },
      });
      const responseFor = (request, { code = 0, status = 200, json = { code, message: "private response" } } = {}) => ({
        url: () => request.url(), request: () => request,
        status: () => status, json: async () => json,
      });
      const titleSavePage = (status, title = "测试标题") => ({
        waitForFunction: async (callback, _options, ...args) => {
          global.document = {
            querySelector: () => ({ value: title }),
            querySelectorAll: () => status ? [{
              textContent: status,
              getBoundingClientRect: () => ({ width: 20, height: 20 }),
            }] : [],
          };
          if (!callback(...args)) throw new Error("title draft not confirmed");
          return { dispose: async () => {} };
        },
      });
      const responses = new EventEmitter();
      const save = tools.observeToutiaoDraftSave(responses);
      save.expect("测试标题", "完整测试正文");
      responses.emit("response", saveResponse("", 0, { title: "其他标题" }));
      await new Promise(resolve => setImmediate(resolve));
      assert.match((await save.waitForInitialTitleSave(1)).reason, /未观察到头条仅标题/u);
      responses.emit("response", saveResponse("<p><br></p>", 0));
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual((await save.waitForInitialTitleSave(1)).confirmed, true);
      assert.strictEqual((await tools.confirmToutiaoInitialDraftAutosave(titleSavePage("草稿已保存"), "测试标题", save, 1)).confirmed, true);
      assert.match((await tools.confirmToutiaoInitialDraftAutosave(titleSavePage("保存失败"), "测试标题", save, 1)).reason, /初始草稿尚未在页面确认/u);
      assert.match((await tools.confirmToutiaoInitialDraftAutosave(titleSavePage("草稿已保存", "不匹配"), "测试标题", save, 1)).reason, /初始草稿尚未在页面确认/u);
      assert.match((await save.waitForFullBodySave(1)).reason, /未观察到头条完整正文/u);
      responses.emit("response", saveResponse("<p>完整测试正文</p>", 0, { pgcId: "draft-1" }));
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual((await save.waitForFullBodySave(1)).confirmed, true);
      assert.strictEqual((await tools.confirmToutiaoDraftAutosave(draftList(true), "测试标题", 1, save)).confirmed, true);
      assert.strictEqual((await tools.confirmToutiaoDraftAutosave(draftList(false), "测试标题", 1, save)).confirmed, false);
      save.stop();
      assert.strictEqual(responses.listenerCount("response"), 0);
      const initialFailureResponses = new EventEmitter();
      const initialFailure = tools.observeToutiaoDraftSave(initialFailureResponses);
      initialFailure.expect("测试标题", "完整测试正文");
      initialFailureResponses.emit("response", saveResponse("", 7050));
      await new Promise(resolve => setImmediate(resolve));
      assert.match((await initialFailure.waitForInitialTitleSave(1)).reason, /初始草稿保存接口拒绝（错误码 7050）/u);
      initialFailure.stop();
      const stringCodeEvents = new EventEmitter();
      const stringCodeSave = tools.observeToutiaoDraftSave(stringCodeEvents);
      stringCodeSave.expect("测试标题", "完整测试正文");
      stringCodeEvents.emit("response", saveResponse("", "0"));
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual((await stringCodeSave.waitForInitialTitleSave(1)).confirmed, true);
      stringCodeSave.stop();
      const noRequestEvents = new EventEmitter();
      const noRequestSave = tools.observeToutiaoDraftSave(noRequestEvents);
      noRequestSave.expect("测试标题", "完整测试正文");
      noRequestEvents.emit("request", saveRequest({ title: "其他标题" }));
      assert.match((await noRequestSave.waitForInitialTitleSave(1)).reason, /未观察到.*初始草稿保存请求/u);
      noRequestSave.stop();

      const pendingEvents = new EventEmitter();
      const pendingSave = tools.observeToutiaoDraftSave(pendingEvents);
      pendingSave.expect("测试标题", "完整测试正文");
      const pendingRequest = saveRequest();
      pendingEvents.emit("request", pendingRequest);
      const pendingReason = (await pendingSave.waitForInitialTitleSave(1)).reason;
      assert.match(pendingReason, /初始草稿保存请求.*(?:未返回|未收到响应|超时)/u);
      assert.doesNotMatch(pendingReason, /private|测试标题|完整测试正文/u);
      pendingSave.stop();

      const networkFailureEvents = new EventEmitter();
      const networkFailureSave = tools.observeToutiaoDraftSave(networkFailureEvents);
      networkFailureSave.expect("测试标题", "完整测试正文");
      const failedRequest = saveRequest({ failure: "net::ERR_CONNECTION_RESET" });
      networkFailureEvents.emit("request", failedRequest);
      networkFailureEvents.emit("requestfailed", failedRequest);
      assert.match((await networkFailureSave.waitForInitialTitleSave(1)).reason, /初始草稿保存.*(?:失败|网络错误)/u);
      networkFailureSave.stop();

      const httpFailureEvents = new EventEmitter();
      const httpFailureSave = tools.observeToutiaoDraftSave(httpFailureEvents);
      httpFailureSave.expect("测试标题", "完整测试正文");
      const httpRequest = saveRequest();
      httpFailureEvents.emit("request", httpRequest);
      httpFailureEvents.emit("response", responseFor(httpRequest, { status: 503 }));
      await new Promise(resolve => setImmediate(resolve));
      assert.match((await httpFailureSave.waitForInitialTitleSave(1)).reason, /(?:HTTP|状态码) 503/u);
      httpFailureSave.stop();

      const changedPathEvents = new EventEmitter();
      const changedPathSave = tools.observeToutiaoDraftSave(changedPathEvents);
      changedPathSave.expect("测试标题", "完整测试正文");
      const changedPathRequest = saveRequest({ url: "https://mp.toutiao.com/mp/agw/article/save?token=private" });
      changedPathEvents.emit("request", changedPathRequest);
      changedPathEvents.emit("response", responseFor(changedPathRequest));
      await new Promise(resolve => setImmediate(resolve));
      const changedPathReason = (await changedPathSave.waitForInitialTitleSave(1)).reason;
      assert.match(changedPathReason, /(?:保存接口路径变化|未识别保存请求)/u);
      assert.doesNotMatch(changedPathReason, /token=private|测试标题/u);
      changedPathSave.stop();

      const invalidResponseEvents = new EventEmitter();
      const invalidResponseSave = tools.observeToutiaoDraftSave(invalidResponseEvents);
      invalidResponseSave.expect("测试标题", "完整测试正文");
      const invalidResponseRequest = saveRequest();
      invalidResponseEvents.emit("request", invalidResponseRequest);
      invalidResponseEvents.emit("response", responseFor(invalidResponseRequest, { json: { status: "success" } }));
      await new Promise(resolve => setImmediate(resolve));
      assert.match((await invalidResponseSave.waitForInitialTitleSave(1)).reason, /响应格式未识别/u);
      invalidResponseSave.stop();

      const unreadableResponseEvents = new EventEmitter();
      const unreadableResponseSave = tools.observeToutiaoDraftSave(unreadableResponseEvents);
      unreadableResponseSave.expect("测试标题", "完整测试正文");
      const unreadableResponseRequest = saveRequest();
      unreadableResponseEvents.emit("request", unreadableResponseRequest);
      unreadableResponseEvents.emit("response", {
        ...responseFor(unreadableResponseRequest),
        json: async () => { throw new Error("private response payload"); },
      });
      await new Promise(resolve => setImmediate(resolve));
      const unreadableReason = (await unreadableResponseSave.waitForInitialTitleSave(1)).reason;
      assert.match(unreadableReason, /响应格式未识别/u);
      assert.doesNotMatch(unreadableReason, /private response payload/u);
      unreadableResponseSave.stop();
      for (const events of [noRequestEvents, pendingEvents, networkFailureEvents, httpFailureEvents, changedPathEvents, invalidResponseEvents, unreadableResponseEvents]) {
        for (const name of ["request", "requestfailed", "response"]) assert.strictEqual(events.listenerCount(name), 0);
      }
      const failedResponses = new EventEmitter();
      const failedSave = tools.observeToutiaoDraftSave(failedResponses);
      failedSave.expect("测试标题", "完整测试正文");
      failedResponses.emit("response", saveResponse("", 0));
      await new Promise(resolve => setImmediate(resolve));
      failedResponses.emit("response", saveResponse("<p>完整测试正文</p>", 7050));
      await new Promise(resolve => setImmediate(resolve));
      assert.match((await failedSave.waitForFullBodySave(1)).reason, /错误码 7050/u);
      failedSave.stop();
      const missingIdResponses = new EventEmitter();
      const missingId = tools.observeToutiaoDraftSave(missingIdResponses);
      missingId.expect("测试标题", "完整测试正文");
      missingIdResponses.emit("response", saveResponse("", 0));
      await new Promise(resolve => setImmediate(resolve));
      missingIdResponses.emit("response", saveResponse("<p>完整测试正文</p>", 0));
      await new Promise(resolve => setImmediate(resolve));
      assert.match((await missingId.waitForFullBodySave(1)).reason, /未携带草稿标识/u);
      missingId.stop();

      const sequence = [];
      let releaseInitial;
      const initialPending = new Promise(resolve => { releaseInitial = resolve; });
      const observer = { expect: () => sequence.push("expect"), stop: () => sequence.push("stop") };
      global.__ttAdapterMocks = {
        observeToutiaoDraftSave: () => observer,
        findArticleEditor: async () => "#editor",
        fillArticleTitle: async () => { sequence.push("title"); },
        confirmToutiaoInitialDraftAutosave: async () => { sequence.push("wait-initial"); return initialPending; },
        renderUploadedArticle: () => "<p>完整测试正文</p>",
        pasteArticleHtml: async () => { sequence.push("body"); },
        confirmToutiaoBodyAccepted: async () => {},
        fillArticleMetadata: async () => {},
        currentUrl: () => before,
        confirmToutiaoDraftAutosave: async () => ({ confirmed: true }),
        finishArticle: async () => { sequence.push("finished"); },
        failArticle: async () => { sequence.push("failed"); },
      };
      const draftPage = { click: async selector => {
        assert.strictEqual(selector, "#editor");
        sequence.push("focus-empty-body");
      } };
      const draftData = { publishToDraft: true, data: { title: "测试标题", content: "完整测试正文", images: [] } };
      const draftRun = publishToutiaoArticle(draftPage, draftData, null, null);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepStrictEqual(sequence, ["expect", "title", "focus-empty-body", "wait-initial"]);
      releaseInitial({ confirmed: true });
      await draftRun;
      assert.deepStrictEqual(sequence, ["expect", "title", "focus-empty-body", "wait-initial", "body", "finished", "stop"]);
      sequence.length = 0;
      global.__ttAdapterMocks.confirmToutiaoInitialDraftAutosave = async () => ({ confirmed: false, reason: "初始草稿未确认" });
      await publishToutiaoArticle(draftPage, draftData, null, null);
      assert.deepStrictEqual(sequence, ["expect", "title", "focus-empty-body", "failed", "stop"]);
      delete global.__ttAdapterMocks;

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
      delete global.__ttAdapterMocks;
      delete global.document;
      delete global.location;
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} catch (error) {
  fs.rmSync(temporary, { recursive: true, force: true });
  throw error;
}
