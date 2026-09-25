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
  buildSync({
    entryPoints: [path.join(root, "src/main/services/upLoad/juejin.js")],
    bundle: true, platform: "node", format: "cjs",
    outfile: path.join(bundleDir, "juejinArticle-test.cjs"), external: ["electron"],
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
  const imageExports = ["selectToutiaoCover", "uploadToutiaoCover", "uploadToutiaoImage"];
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
  const { canonicalJuejinDraftUrl, default: publishJuejinArticle } =
    require(path.join(bundleDir, "juejinArticle-test.cjs"));
  const upload = require(path.join(bundleDir, "articleImageUpload.cjs"));
  assert.strictEqual(canonicalJuejinDraftUrl("https://juejin.cn/editor/drafts/123456?source=editor"),
    "https://juejin.cn/editor/drafts/123456");
  for (const url of ["https://juejin.cn/editor/drafts/new", "https://juejin.cn/editor/drafts",
    "https://juejin.cn/editor/drafts/123/extra", "https://evil.example/editor/drafts/123",
    "http://juejin.cn/editor/drafts/123", "https://juejin.cn/editor/drafts/%2Fadmin",
    "https://juejin.cn:8443/editor/drafts/123", "https://juejin.cn/editor/drafts/123#section",
    `https://juejin.cn/editor/drafts/${"a".repeat(129)}`]) {
    assert.strictEqual(canonicalJuejinDraftUrl(url), "", `unsafe Juejin draft URL: ${url}`);
  }
  assert.strictEqual(tools.canonicalToutiaoDraftUrl(
    "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=draft-1&token=private"),
  "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=draft-1");
  for (const url of ["https://mp.toutiao.com/profile_v4/graphic/publish",
    "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=",
    "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=1&pgc_id=2",
    "https://evil.example/profile_v4/graphic/publish?pgc_id=1",
    "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=%2Fadmin",
    "https://mp.toutiao.com:8443/profile_v4/graphic/publish?pgc_id=1",
    "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=1#section",
    `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${"a".repeat(129)}`]) {
    assert.strictEqual(tools.canonicalToutiaoDraftUrl(url), "", `unsafe Toutiao draft URL: ${url}`);
  }
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
      const juejinReplies = [];
      let juejinStep = 0;
      await publishJuejinArticle({
        waitForSelector: async () => {},
        click: async selector => assert.strictEqual(selector, ".header .title-input"),
        type: async () => {},
        keyboard: { press: async () => {} },
        waitForTimeout: async () => {},
        evaluate: async () => {
          juejinStep++;
          return juejinStep === 4
            ? { url: "https://juejin.cn/editor/drafts/123456?source=editor", saved: true }
            : true;
        },
      }, {
        data: { title: "测试标题", content: "完整测试正文" },
        publishToDraft: true, closeWindowAfterPublish: false,
      }, null, { reply: (channel, payload) => juejinReplies.push({ channel, payload }) });
      assert.strictEqual(juejinStep, 4, "掘金草稿流程不能进入发布弹窗");
      assert.strictEqual(juejinReplies[0].channel, "puppeteerFile-done");
      assert.strictEqual(juejinReplies[0].payload.status, true);
      assert.strictEqual(juejinReplies[0].payload.draftUrl,
        "https://juejin.cn/editor/drafts/123456");

      await build(toutiaoAdapterBuild);
      const publishToutiaoArticle = require(path.join(bundleDir, "ttArticle-test.cjs")).default;
      const before = "https://mp.toutiao.com/profile_v4/graphic/publish";
      const titleElements = [
        { value: "旧值", getBoundingClientRect: () => ({ width: 0, height: 0 }) },
        {
          value: "", getBoundingClientRect: () => ({ width: 420, height: 40 }),
          setAttribute(name, value) { this[name] = value; },
          removeAttribute(name) { delete this[name]; },
        },
      ];
      const oldGetComputedStyle = global.getComputedStyle;
      global.getComputedStyle = () => ({ visibility: "visible" });
      const titlePage = {
        waitForSelector: async () => {},
        evaluate: async (callback, ...args) => {
          global.document = { querySelectorAll: selector => selector === "[data-ebao-article-title]"
            ? [] : titleElements };
          return callback(...args);
        },
        click: async selector => assert.strictEqual(selector, "[data-ebao-article-title='true']"),
        keyboard: { press: async key => assert.strictEqual(key, "Backspace") },
        type: async (selector, title) => {
          assert.strictEqual(selector, "[data-ebao-article-title='true']");
          assert.strictEqual(title, "测试标题");
        },
        waitForFunction: async (callback, _options, ...args) => {
          global.document = { querySelectorAll: () => titleElements };
          assert.strictEqual(callback(...args), false);
          titleElements[1] = { ...titleElements[1], value: "测试标题" }; // React replaced the marked input.
          assert.strictEqual(callback(...args), true);
        },
      };
      assert.strictEqual(await tools.fillArticleTitle(titlePage, "测试标题", { stableVisible: true }),
        "[data-ebao-article-title='true']");
      assert.strictEqual(titleElements[0].value, "旧值");
      assert.strictEqual(titleElements[1]["data-ebao-article-title"], "true");
      titleElements[1].value = "";
      await assert.rejects(tools.fillArticleTitle({ ...titlePage,
        evaluate: async (callback, ...args) => {
          global.document = { querySelectorAll: () => [titleElements[1], {
            getBoundingClientRect: () => ({ width: 420, height: 40 }),
          }] };
          return callback(...args);
        },
      }, "测试标题", { stableVisible: true }), /标题输入框未能唯一定位/u);
      global.getComputedStyle = oldGetComputedStyle;
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
            global.document = atDashboard ? { querySelectorAll: () => [{
              textContent: listed === true ? "测试标题" : listed || "暂无草稿",
              getBoundingClientRect: () => ({ width: 20 }), children: [],
            }] } : {};
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
      assert.strictEqual((await tools.confirmToutiaoDraftAutosave(draftList("测试标题加后缀"), "测试标题", 1, save)).confirmed, false);
      const reopenedDraft = ({ body = "开头文字不可丢失的中段结尾文字",
        cover = "https://example.com/cover.png", titleCount = 1, currentUrl = "" } = {}) => {
        const editUrl = "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=draft-1";
        const titleNode = () => ({
          textContent: "测试标题", children: [],
          getBoundingClientRect: () => ({ width: 120, height: 25 }),
        });
        const editPage = {
          url: () => currentUrl || editUrl,
          waitForSelector: async () => {},
          evaluate: async () => "[data-ebao-article-editor='true']",
          waitForFunction: async (callback, _options, ...args) => {
            const coverArea = {
              getBoundingClientRect: () => ({ width: 150, height: 90 }),
              querySelectorAll: () => cover ? [{
                complete: true, naturalWidth: 800, currentSrc: cover, src: cover,
                getAttribute: () => cover,
              }] : [],
            };
            global.document = { querySelector: selector => selector === args[0]
              ? { value: "测试标题" }
              : selector === args[1] ? { textContent: body }
                : selector === ".article-cover-images-wrap" ? coverArea : null };
            global.location = { href: editUrl };
            if (!callback(...args)) throw new Error("reopened draft mismatch");
          },
          close: async () => {},
        };
        const target = { url: () => editUrl, page: async () => editPage };
        let targets = [];
        const browser = {
          targets: () => targets,
          waitForTarget: async predicate => {
            targets = [target];
            assert.strictEqual(predicate(target), true);
            return target;
          },
        };
        return {
          goto: async () => {},
          waitForFunction: async (callback, _options, ...args) => {
            global.document = { querySelectorAll: () => Array.from({ length: titleCount }, titleNode) };
            if (!callback(...args)) throw new Error("draft title mismatch");
          },
          evaluate: async () => ({ marked: true, editHref: editUrl }),
          browser: () => browser,
          click: async selector => { assert.strictEqual(selector, "[data-ebao-draft-edit='true']"); },
        };
      };
      const reopenOptions = { expectedHtml: "<p>开头文字</p><p>不可丢失的中段</p><p>结尾文字</p>",
        coverUrl: "https://example.com/cover.png" };
      assert.deepStrictEqual(await tools.confirmToutiaoDraftAutosave(reopenedDraft(), "测试标题", 1,
        save, reopenOptions), { confirmed: true, draftUrl:
          "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=draft-1" });
      assert.deepStrictEqual(await tools.confirmToutiaoDraftAutosave(reopenedDraft({ currentUrl:
        "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=draft-2" }), "测试标题", 1,
        save, reopenOptions), { confirmed: true });
      assert.match((await tools.confirmToutiaoDraftAutosave(reopenedDraft({ body: "开头文字结尾文字" }),
        "测试标题", 1, save, reopenOptions)).reason, /未确认完整正文/u);
      assert.match((await tools.confirmToutiaoDraftAutosave(reopenedDraft({ cover: "" }),
        "测试标题", 1, save, reopenOptions)).reason, /未确认封面/u);
      assert.strictEqual((await tools.confirmToutiaoDraftAutosave(reopenedDraft({ titleCount: 2 }),
        "测试标题", 1, save, reopenOptions)).confirmed, false);
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
      missingIdResponses.emit("response", saveResponse("<p>完整测试正文</p>", 0));
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual((await missingId.waitForFullBodySave(1)).confirmed, true);
      missingId.stop();

      const partialEvents = new EventEmitter();
      const partialSave = tools.observeToutiaoDraftSave(partialEvents);
      partialSave.expect("测试标题", "完整测试正文，开头已录入。\n\n但这一段必须出现在最后保存的请求里。");
      partialEvents.emit("response", saveResponse("<p>完整测试正文，开头已录入。</p>", 0));
      await new Promise(resolve => setImmediate(resolve));
      assert.match((await partialSave.waitForFullBodySave(1)).reason, /正文不完整或与待发布正文不一致/u);
      partialEvents.emit("response", saveResponse("<p>完整测试正文，开头已录入。</p><p>但这一段必须出现在最后保存的请求里。</p>", 0));
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual((await partialSave.waitForFullBodySave(1)).confirmed, true);
      partialSave.stop();

      const missingMiddleEvents = new EventEmitter();
      const missingMiddle = tools.observeToutiaoDraftSave(missingMiddleEvents);
      const completeHtml = "<p>开头文字</p><p>不可丢失的中段</p><p>结尾文字</p>";
      missingMiddle.expect("测试标题", "开头文字\n不可丢失的中段\n结尾文字", completeHtml);
      missingMiddleEvents.emit("response", saveResponse("<p>开头文字</p><p>结尾文字</p>", 0));
      await new Promise(resolve => setImmediate(resolve));
      assert.match((await missingMiddle.waitForFullBodySave(1)).reason, /正文不完整或与待发布正文不一致/u);
      missingMiddleEvents.emit("response", saveResponse(completeHtml, 0));
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual((await missingMiddle.waitForFullBodySave(1)).confirmed, true);
      missingMiddle.stop();

      const savingMarkerEvents = new EventEmitter();
      savingMarkerEvents.evaluate = async callback => {
        global.document = { querySelectorAll: () => [{
          textContent: "草稿保存中...", children: [],
          getBoundingClientRect: () => ({ width: 100, height: 24 }),
        }] };
        return callback();
      };
      const savingMarker = tools.observeToutiaoDraftSave(savingMarkerEvents);
      savingMarker.expect("测试标题", "完整测试正文", "<p>完整测试正文</p>");
      assert.match((await savingMarker.waitForFullBodySave(1)).reason, /页面仍显示草稿保存中/u);
      savingMarker.stop();
      const savedMarkerEvents = new EventEmitter();
      savedMarkerEvents.evaluate = async callback => {
        global.document = { querySelectorAll: () => [{
          textContent: "草稿已保存", children: [],
          getBoundingClientRect: () => ({ width: 100, height: 24 }),
        }] };
        return callback();
      };
      const observedSavedMarker = tools.observeToutiaoDraftSave(savedMarkerEvents);
      observedSavedMarker.expect("测试标题", "完整测试正文", "<p>完整测试正文</p>");
      assert.match((await observedSavedMarker.waitForFullBodySave(1)).reason, /页面显示已保存，但无法确认完整正文/u);
      observedSavedMarker.stop();
      const rejectedMarkerEvents = new EventEmitter();
      const rejectedStates = ["saving", "saved"];
      rejectedMarkerEvents.evaluate = async () => rejectedStates.shift() || "saved";
      const rejectedMarker = tools.observeToutiaoDraftSave(rejectedMarkerEvents);
      rejectedMarker.expect("测试标题", "完整测试正文", "<p>完整测试正文</p>");
      rejectedMarkerEvents.emit("response", saveResponse("<p>完整测试正文</p>", 7050));
      await new Promise(resolve => setImmediate(resolve));
      assert.match((await rejectedMarker.waitForFullBodySave(1)).reason, /错误码 7050/u);
      rejectedMarker.stop();
      const alternatePathEvents = new EventEmitter();
      const alternatePath = tools.observeToutiaoDraftSave(alternatePathEvents);
      alternatePath.expect("测试标题", "完整测试正文", "<p>完整测试正文</p>");
      alternatePathEvents.emit("request", saveRequest({
        content: "<p>完整测试正文</p>",
        url: "https://mp.toutiao.com/mp/agw/article/save?token=private",
      }));
      assert.match((await alternatePath.waitForFullBodySave(1)).reason, /接口路径/u);
      alternatePath.stop();
      const missingContentEvents = new EventEmitter();
      const missingContent = tools.observeToutiaoDraftSave(missingContentEvents);
      missingContent.expect("测试标题", "完整测试正文", "<p>完整测试正文</p>");
      missingContentEvents.emit("request", {
        ...saveRequest(), postData: () => new URLSearchParams({ title: "测试标题" }).toString(),
      });
      const missingContentReason = (await missingContent.waitForFullBodySave(1)).reason;
      assert.match(missingContentReason, /请求体格式未识别/u);
      assert.doesNotMatch(missingContentReason, /完整测试正文|token=private/u);
      missingContent.stop();

      const sequence = [];
      const saveOptions = [];
      const observer = {
        expect: (_title, _content, html) => sequence.push(html ? `expect-html:${html}` : "expect"),
        waitForFullBodySave: async () => { sequence.push("body-saved"); return { confirmed: true }; },
        stop: () => sequence.push("stop"),
      };
      global.__ttAdapterMocks = {
        observeToutiaoDraftSave: () => observer,
        findArticleEditor: async () => "#editor",
        fillArticleTitle: async (_page, _title, options) => {
          assert.deepStrictEqual(options, { stableVisible: true });
          sequence.push("title"); return "#title";
        },
        renderUploadedArticle: () => "<p>完整测试正文</p>",
        pasteArticleHtml: async (_page, _editor, _html, _plain, _context, _images, options) => {
          assert.strictEqual(options.verifyWholeBody, true);
          sequence.push("body");
        },
        confirmToutiaoBodyAccepted: async () => { sequence.push("word-count"); },
        fillArticleMetadata: async () => {},
        currentUrl: () => before,
        confirmToutiaoDraftAutosave: async (_page, _title, _timeout, _observer, options) => {
          saveOptions.push(options);
          return { confirmed: true };
        },
        uploadToutiaoImage: async () => { sequence.push("inline-upload"); return "https://example.com/cover.png"; },
        uploadToutiaoCover: async (_page, _editor, _asset, waitForSave) => {
          assert.strictEqual(waitForSave, true);
          sequence.push("cover-upload");
          return "https://example.com/cover.png";
        },
        selectToutiaoCover: async (_page, _url, waitForSave) => {
          assert.strictEqual(waitForSave, true);
          sequence.push("cover-select");
        },
        finishArticle: async () => { sequence.push("finished"); },
        failArticle: async () => { sequence.push("failed"); },
      };
      const draftPage = { click: async selector => {
        assert.strictEqual(selector, "#title");
        sequence.push("blur");
      } };
      const draftData = { publishToDraft: true, data: { title: "测试标题", content: "完整测试正文", images: [] } };
      await publishToutiaoArticle(draftPage, draftData, null, null);
      assert.deepStrictEqual(sequence, ["expect", "title", "expect-html:<p>完整测试正文</p>", "body", "word-count", "blur", "finished", "stop"]);
      assert.deepStrictEqual(saveOptions.at(-1), { expectedHtml: "<p>完整测试正文</p>", coverUrl: "" });
      sequence.length = 0;
      await publishToutiaoArticle({
        ...draftPage,
        click: async () => { throw new Error("stale title marker"); },
        evaluate: async () => { sequence.push("blur-fallback"); },
      }, draftData, null, null);
      assert.deepStrictEqual(sequence, ["expect", "title", "expect-html:<p>完整测试正文</p>",
        "body", "word-count", "blur-fallback", "finished", "stop"]);
      sequence.length = 0;
      global.__ttAdapterMocks.confirmToutiaoDraftAutosave = async () => ({ confirmed: false, reason: "完整正文保存未确认" });
      await publishToutiaoArticle(draftPage, draftData, null, null);
      assert.deepStrictEqual(sequence, ["expect", "title", "expect-html:<p>完整测试正文</p>", "body", "word-count", "blur", "failed", "stop"]);
      sequence.length = 0;
      global.__ttAdapterMocks.confirmToutiaoDraftAutosave = async (_page, _title, _timeout, _observer, options) => {
        saveOptions.push(options);
        return { confirmed: true };
      };
      await publishToutiaoArticle(draftPage, {
        ...draftData, data: { ...draftData.data, coverPath: "/tmp/cover.png", coverMime: "image/png" },
      }, null, null);
      assert.deepStrictEqual(sequence, ["expect", "title", "expect-html:<p>完整测试正文</p>", "body", "word-count", "blur", "body-saved", "cover-upload", "finished", "stop"]);
      assert.deepStrictEqual(saveOptions.at(-1), {
        expectedHtml: "<p>完整测试正文</p>", coverUrl: "https://example.com/cover.png",
      });
      sequence.length = 0;
      global.__ttAdapterMocks.uploadToutiaoCover = async () => {
        sequence.push("cover-save-unconfirmed");
        throw new Error("头条封面已显示，但未确认草稿已保存");
      };
      await publishToutiaoArticle(draftPage, {
        ...draftData, data: { ...draftData.data, coverPath: "/tmp/cover.png", coverMime: "image/png" },
      }, null, null);
      assert.deepStrictEqual(sequence, ["expect", "title", "expect-html:<p>完整测试正文</p>",
        "body", "word-count", "blur", "body-saved", "cover-save-unconfirmed", "failed", "stop"]);
      sequence.length = 0;
      observer.waitForFullBodySave = async () => {
        sequence.push("body-save-unconfirmed");
        return { confirmed: false, reason: "正文尚未保存" };
      };
      await publishToutiaoArticle(draftPage, {
        ...draftData, data: { ...draftData.data, coverPath: "/tmp/cover.png", coverMime: "image/png" },
      }, null, null);
      assert.deepStrictEqual(sequence, ["expect", "title", "expect-html:<p>完整测试正文</p>",
        "body", "word-count", "blur", "body-save-unconfirmed", "failed", "stop"]);
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

        const wholeBody = editorPage({ paste: true });
        await tools.pasteArticleHtml(wholeBody.page, "#editor", "<p>开头内容</p><p>中间内容</p><p>结尾内容</p>",
          "开头内容\n中间内容\n结尾内容", wholeBody.page, [], { verifyWholeBody: true });
        const truncated = editorPage({ paste: true });
        truncated.page.evaluate = async (callback, ...args) => {
          global.document = { querySelector: () => ({
            innerHTML: "<p>开头内容</p><p>中间内容</p>", textContent: "开头内容中间内容", querySelectorAll: () => [], focus: () => {},
            dispatchEvent: () => {},
          }), execCommand: () => {} };
          return callback(...args);
        };
        await assert.rejects(tools.pasteArticleHtml(truncated.page, "#editor",
          "<p>开头内容</p><p>中间内容</p><p>结尾内容</p>", "开头内容\n中间内容\n结尾内容",
          truncated.page, [], { verifyWholeBody: true }), /文章正文未(?:完整)?写入/u);

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
      await tools.finishArticle(pageAt(before), { pt: "头条", closeWindowAfterPublish: false }, null,
        { reply: (_channel, payload) => calls.push(payload) }, "draft", before, true,
        "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=draft-1");
      assert.strictEqual(calls[1].draftUrl,
        "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=draft-1");
      await tools.finishArticle(pageAt(before), { pt: "头条", closeWindowAfterPublish: false }, null,
        { reply: (_channel, payload) => calls.push(payload) }, "publish", before, true,
        "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=draft-1");
      assert.strictEqual(calls[2].status, true);
      assert.strictEqual(calls[2].draftUrl, undefined);

      const fileInput = (accept, parentElement = null, id = "") => {
        const attributes = { accept };
        return {
          id, parentElement,
          getAttribute: name => attributes[name] || "",
          setAttribute: (name, value) => { attributes[name] = value; },
          removeAttribute: name => { delete attributes[name]; },
        };
      };
      const imagePanelClicks = [];
      const confirmButton = {
        textContent: "确定", disabled: true,
        getAttribute: () => "",
        getBoundingClientRect: () => ({ width: 80, height: 30 }),
        click: () => imagePanelClicks.push("panel-confirm"),
      };
      const panelAttributes = {};
      const imagePanel = {
        textContent: "上传图片 我的素材 本地上传 已上传 0 张图片",
        parentElement: null,
        matches: selector => selector.includes("[role='dialog']"),
        querySelectorAll: selector => selector === "button,[role='button']" ? [confirmButton] : [],
        getBoundingClientRect: () => ({ width: 400, height: 300 }),
        setAttribute: (name, value) => { panelAttributes[name] = value; },
        removeAttribute: name => { delete panelAttributes[name]; },
      };
      const localControl = textContent => ({
        textContent, parentElement: imagePanel,
        matches: selector => selector.includes("label"),
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: 100, height: 30 }),
      });
      const localImage = fileInput("", localControl("本地上传 Choose Files"));
      const unrelatedVideo = fileInput("video/*", localControl("本地上传 Choose Files"));
      const unrelatedGeneric = fileInput("", imagePanel);
      let panelInputs = [unrelatedVideo, unrelatedGeneric, localImage];
      global.document = {
        body: {},
        querySelectorAll: selector => selector === "input[type='file']" ? panelInputs
          : selector === "[data-ebao-toutiao-image-panel]" && panelAttributes["data-ebao-toutiao-image-panel"]
            ? [imagePanel] : [],
        querySelector: selector => selector === "[data-ebao-toutiao-image-panel='true']"
          && panelAttributes["data-ebao-toutiao-image-panel"] ? imagePanel : null,
      };
      assert.strictEqual(upload.markToutiaoImageFileInput(), "input[data-ebao-inline-upload='true']");
      assert.strictEqual(localImage.getAttribute("data-ebao-inline-upload"), "true");
      assert.strictEqual(unrelatedGeneric.getAttribute("data-ebao-inline-upload"), "");
      assert.strictEqual(unrelatedVideo.getAttribute("data-ebao-inline-upload"), "");
      assert.strictEqual(panelAttributes["data-ebao-toutiao-image-panel"], "true");
      assert.strictEqual(upload.readToutiaoImagePanelUploadCount(), 0);
      assert.strictEqual(upload.isToutiaoImagePanelUploadReady(0), false);
      assert.strictEqual(upload.clickToutiaoImagePanelConfirm(0), false);
      imagePanel.textContent = "上传图片 我的素材 本地上传 已上传 1 张图片";
      confirmButton.disabled = false;
      assert.strictEqual(upload.isToutiaoImagePanelUploadReady(0), true);
      assert.strictEqual(upload.clickToutiaoImagePanelConfirm(0), true);
      assert.deepStrictEqual(imagePanelClicks, ["panel-confirm"]);
      assert.strictEqual(upload.isToutiaoImagePanelUploadReady(1), false);

      const fallbackImage = fileInput("image/png,.jpg", imagePanel);
      panelInputs = [unrelatedGeneric, fallbackImage];
      assert.strictEqual(upload.markToutiaoImageFileInput(), "input[data-ebao-inline-upload='true']");
      assert.strictEqual(fallbackImage.getAttribute("data-ebao-inline-upload"), "true");
      panelInputs = [fallbackImage, fileInput("image/webp", imagePanel)];
      assert.strictEqual(upload.markToutiaoImageFileInput(), "");
      panelInputs = [unrelatedVideo, unrelatedGeneric];
      assert.strictEqual(upload.markToutiaoImageFileInput(), "");
      imagePanel.matches = () => false;
      panelInputs = [localImage];
      assert.strictEqual(upload.markToutiaoImageFileInput(), "input[data-ebao-inline-upload='true']");
      imagePanel.matches = selector => selector.includes("[role='dialog']");
      imagePanel.getBoundingClientRect = () => ({ width: 0, height: 0 });
      assert.strictEqual(upload.markToutiaoImageFileInput(), "");
      imagePanel.getBoundingClientRect = () => ({ width: 400, height: 300 });

      const addClicks = [];
      const addButton = {
        textContent: "+", getAttribute: () => "",
        getBoundingClientRect: () => ({ width: 36, height: 36 }),
        click: () => addClicks.push("plus"),
      };
      const coverArea = {
        querySelectorAll: () => [addButton], click: () => addClicks.push("area"),
      };
      global.document.querySelector = selector => selector === ".article-cover-images-wrap" ? coverArea : null;
      assert.strictEqual(upload.openToutiaoCoverPanel(), true);
      assert.deepStrictEqual(addClicks, ["plus"]);

      const originalMutationObserver = global.MutationObserver;
      const savedMarker = {
        textContent: "草稿已保存",
        getBoundingClientRect: () => ({ width: 100, height: 20 }),
      };
      let savedMarkers = [savedMarker];
      let coverImages = [];
      let onMutation;
      let disconnected = false;
      global.MutationObserver = class {
        constructor(callback) { onMutation = callback; }
        observe() {}
        disconnect() { disconnected = true; }
      };
      global.document = { body: {}, querySelectorAll: selector =>
        selector === ".article-cover-images-wrap img" ? coverImages : savedMarkers };
      try {
        upload.startToutiaoCoverSaveWatch();
        assert.strictEqual(upload.hasToutiaoCoverSaveTransition(), false);
        onMutation(); // A pre-existing saved marker is not a new cover save.
        assert.strictEqual(upload.hasToutiaoCoverSaveTransition(), false);
        savedMarkers = [];
        onMutation();
        savedMarkers = [savedMarker];
        onMutation();
        assert.strictEqual(upload.hasToutiaoCoverSaveTransition(), false);
        coverImages = [{ getAttribute: () => "https://example.com/cover.png" }];
        onMutation();
        assert.strictEqual(upload.hasToutiaoCoverSaveTransition(), false);
        savedMarkers = [];
        onMutation();
        savedMarkers = [savedMarker];
        onMutation();
        assert.strictEqual(upload.hasToutiaoCoverSaveTransition(), true);
        upload.stopToutiaoCoverSaveWatch();
        assert.strictEqual(disconnected, true);
      } finally {
        global.MutationObserver = originalMutationObserver;
      }

      const titleElement = {};
      const articleRoot = {
        parentElement: null, contains: element => element === titleElement,
        querySelectorAll: selector => selector.includes("toolbar") ? [toolbarElement] : toolbarButtons,
      };
      const editorElement = { parentElement: articleRoot };
      const clickedButtons = [];
      const toolbarButtons = Array.from({ length: 12 }, (_, index) => ({
        textContent: "", getAttribute: name => index === 3 && name === "title" ? "" : "",
        getBoundingClientRect: () => ({ top: 160, bottom: 188, left: 100 + index * 35,
          right: 128 + index * 35, width: 28, height: 28 }),
        click: () => clickedButtons.push(index),
      }));
      const toolbarElement = {
        getBoundingClientRect: () => ({ top: 155, bottom: 190, left: 100, right: 540, width: 440, height: 35 }),
        getAttribute: () => "", querySelectorAll: () => toolbarButtons,
      };
      global.document = {
        querySelector: selector => selector === "#editor" ? editorElement : titleElement,
      };
      assert.strictEqual(upload.clickToutiaoImageToolbarButton("#editor"), true);
      assert.deepStrictEqual(clickedButtons, [11]);
      toolbarButtons[3].getAttribute = name => name === "title" ? "插入图片" : "";
      assert.strictEqual(upload.clickToutiaoImageToolbarButton("#editor"), true);
      assert.deepStrictEqual(clickedButtons, [11, 3]);
      toolbarButtons[3].getAttribute = () => "";
      toolbarButtons[11].textContent = "发布";
      assert.strictEqual(upload.clickToutiaoImageToolbarButton("#editor"), false);
      assert.deepStrictEqual(clickedButtons, [11, 3]);
      let evaluations = 0;
      await assert.rejects(upload.uploadToutiaoImage({
        evaluate: async () => ++evaluations === 1 ? [] : false,
        click: async () => {},
      }, "#editor", { path: "/tmp/image.png", mime: "image/png" }), /未找到头条文章图片工具栏按钮/u);
      assert.strictEqual(evaluations, 2);

      const image = path.join(temporary, "test.png");
      fs.writeFileSync(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
      const coverSteps = [];
      let coverRead = 0;
      const coverPage = {
        evaluate: async callback => {
          if (!callback.name) return ++coverRead === 1
            ? { cover: [], body: [] } : { cover: "https://example.com/cover.png", body: [] };
          coverSteps.push(callback.name);
          if (callback.name === "openToutiaoCoverPanel") return true;
          if (callback.name === "markToutiaoImageFileInput") return "input[data-ebao-inline-upload='true']";
          if (callback.name === "readToutiaoImagePanelUploadCount") return 0;
          if (callback.name === "clickToutiaoImagePanelConfirm") return true;
          return undefined;
        },
        $: async () => ({ uploadFile: async () => { coverSteps.push("uploadFile"); } }),
        waitForFunction: async callback => { coverSteps.push(`wait:${callback.name || "cover-image"}`); },
        click: async () => { throw new Error("cover upload must not click the editor"); },
      };
      assert.strictEqual(await upload.uploadToutiaoCover(coverPage, "#editor",
        { path: image, mime: "image/png" }, true), "https://example.com/cover.png");
      assert.deepStrictEqual(coverSteps, [
        "openToutiaoCoverPanel", "markToutiaoImageFileInput", "readToutiaoImagePanelUploadCount",
        "uploadFile", "wait:isToutiaoImagePanelUploadReady", "startToutiaoCoverSaveWatch",
        "clickToutiaoImagePanelConfirm", "wait:cover-image", "wait:hasToutiaoCoverSaveTransition",
        "stopToutiaoCoverSaveWatch",
      ]);
      coverSteps.length = 0;
      coverRead = 0;
      coverPage.waitForFunction = async callback => {
        coverSteps.push(`wait:${callback.name || "cover-image"}`);
        if (callback.name === "hasToutiaoCoverSaveTransition") throw new Error("timeout");
      };
      coverPage.goto = async () => { throw new Error("unconfirmed cover must not navigate"); };
      await assert.rejects(upload.uploadToutiaoCover(coverPage, "#editor",
        { path: image, mime: "image/png" }, true), /未确认草稿已保存/u);
      assert.strictEqual(coverSteps.at(-1), "stopToutiaoCoverSaveWatch");

      const reusedCoverSteps = [];
      const reusedCoverPage = {
        evaluate: async callback => {
          reusedCoverSteps.push(callback.name || "cover-picker-action");
          return true;
        },
        waitForFunction: async callback => {
          reusedCoverSteps.push(`wait:${callback.name || "cover-picker"}`);
          if (callback.name === "hasToutiaoCoverSaveTransition") throw new Error("timeout");
        },
        goto: async () => { throw new Error("unconfirmed cover must not navigate"); },
      };
      await assert.rejects(upload.selectToutiaoCover(reusedCoverPage,
        "https://example.com/cover.png", true), /未确认草稿已保存/u);
      assert.strictEqual(reusedCoverSteps.at(-1), "stopToutiaoCoverSaveWatch");

      const inlineSteps = [];
      let inlineRead = 0;
      const inlinePage = {
        evaluate: async callback => {
          if (!callback.name) return ++inlineRead === 1 ? [] : "https://example.com/inline.png";
          inlineSteps.push(callback.name);
          if (callback.name === "clickToutiaoImageToolbarButton") return true;
          if (callback.name === "markToutiaoImageFileInput") return "input[data-ebao-inline-upload='true']";
          if (callback.name === "readToutiaoImagePanelUploadCount") return 0;
          if (callback.name === "clickToutiaoImagePanelConfirm") return true;
          return undefined;
        },
        $: async () => ({ uploadFile: async () => { inlineSteps.push("uploadFile"); } }),
        waitForFunction: async callback => { inlineSteps.push(`wait:${callback.name || "editor-image"}`); },
        click: async selector => { assert.strictEqual(selector, "#editor"); inlineSteps.push("editor-click"); },
      };
      assert.strictEqual(await upload.uploadToutiaoImage(inlinePage, "#editor",
        { path: image, mime: "image/png" }), "https://example.com/inline.png");
      assert.deepStrictEqual(inlineSteps, [
        "editor-click", "clickToutiaoImageToolbarButton", "markToutiaoImageFileInput",
        "readToutiaoImagePanelUploadCount", "uploadFile", "wait:isToutiaoImagePanelUploadReady",
        "clickToutiaoImagePanelConfirm", "wait:editor-image",
      ]);
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
