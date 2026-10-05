"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const webpack = require("webpack");
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
    "fillArticleMetadata", "fillArticleTitle", "verifyVisibleArticleTitle", "findArticleEditor", "finishArticle",
    "observeToutiaoDraftSave", "pasteArticleHtml", "renderUploadedArticle",
  ];
  const toutiaoAdapterBuild = {
    entryPoints: [path.join(root, "src/main/services/upLoad/ttArticle.js")],
    bundle: true, platform: "node", format: "cjs",
    outfile: path.join(bundleDir, "ttArticle-test.cjs"),
    plugins: [{
      name: "mock-toutiao-adapter-dependencies",
      setup(build) {
        build.onResolve({ filter: /^\.\/articleWebTools\.js$/u }, () => ({
          path: "web", namespace: "tt-article-test",
        }));
        build.onLoad({ filter: /.*/u, namespace: "tt-article-test" }, () => ({
          contents: webExports
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
  const upload = Object.assign({}, require(path.join(bundleDir, "articleImageUpload.cjs")));
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
      // 使用正式 webpack 的默认 esbuild-loader 降级与生产压缩，不能让源模块闭包掩盖注入缺失。
      const workerWebpack = require(path.join(root, ".electron-vue/webpack.main.config.js"));
      const productionUploadPath = path.join(temporary, "webpack", "articleImageUpload.cjs");
      await new Promise((resolve, reject) => {
        const compiler = webpack({
          mode: "production", target: workerWebpack.target,
          entry: path.join(root, "src/main/services/upLoad/articleImageUpload.js"),
          module: workerWebpack.module, externals: workerWebpack.externals,
          resolve: workerWebpack.resolve,
          output: { path: path.dirname(productionUploadPath), filename: path.basename(productionUploadPath),
            library: { type: "commonjs2" } },
          optimization: { minimize: true },
          infrastructureLogging: { level: "error" },
        });
        compiler.run((error, stats) => compiler.close(closeError => {
          if (error || closeError) return reject(error || closeError);
          if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
          resolve();
        }));
      });
      const productionUpload = require(productionUploadPath);
      const browserContext = vm.createContext({});
      const executeBrowserFunction = (callback, globals, args = []) => {
        Object.assign(browserContext, globals);
        return vm.runInContext(`(${callback.toString()})`, browserContext)(...args);
      };
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
      const titleWrites = [];
      let titleEvaluations = 0;
      let titleReads = 0;
      let focusedTitle;
      const visibleTitle = initialValue => {
        let value = initialValue;
        return {
          get value() { titleReads++; return value; },
          set value(next) { value = next; },
          getBoundingClientRect: () => ({ width: 420, height: 40 }),
          setAttribute(name, attribute) { this[name] = attribute; },
          removeAttribute(name) { delete this[name]; },
          focus() { focusedTitle = this; },
        };
      };
      titleElements[1] = visibleTitle("");
      const initialTitleInput = titleElements[1];
      const oldGetComputedStyle = global.getComputedStyle;
      global.getComputedStyle = () => ({ visibility: "visible" });
      const titlePage = {
        waitForSelector: async () => {},
        evaluate: async (callback, ...args) => {
          titleEvaluations++;
          global.document = { querySelectorAll: selector => selector === "[data-ebao-article-title]"
            ? titleElements.filter(element => element["data-ebao-article-title"])
            : titleElements };
          return callback(...args);
        },
        click: async selector => {
          assert.strictEqual(selector, "[data-ebao-article-title='true']");
          titleElements[1].focus();
        },
        keyboard: {
          press: async key => {
            assert.strictEqual(key, "Backspace");
            // 清空受控框会重建输入框，旧 focus/marker 都不能继续依赖。
            titleElements[1] = visibleTitle("");
          },
          sendCharacter: async title => {
            assert.notStrictEqual(titleElements[1], initialTitleInput);
            assert.strictEqual(focusedTitle, titleElements[1], "整段标题必须写入清空后重新定位的新可见框");
            titleWrites.push(title);
            // 输入结束并不保证 React 已保留完整值；先继续正文，再单次核对。
            titleElements[1].value = "测试";
          },
        },
        type: async () => assert.fail("头条标题必须一次性整段输入"),
        $eval: async () => assert.fail("标题输入后不能阻塞回读"),
        waitForFunction: async () => assert.fail("标题输入后不能等待值匹配"),
      };
      assert.strictEqual(await tools.fillArticleTitle(titlePage, "测试标题", { stableVisible: true }),
        "[data-ebao-article-title='true']");
      assert.deepStrictEqual(titleWrites, ["测试标题"]);
      assert.strictEqual(titleEvaluations, 2, "清空后应同步重新定位一次，不轮询");
      assert.strictEqual(titleReads, 0, "输入标题不应读取或等待标题值");
      assert.strictEqual(titleElements[0].value, "旧值");
      assert.strictEqual(titleElements[1]["data-ebao-article-title"], "true");
      const originalTitle = titleElements[1];
      titleElements[1] = visibleTitle("测试标题");
      titleEvaluations = 0;
      await tools.verifyVisibleArticleTitle(titlePage, "测试标题");
      assert.strictEqual(titleEvaluations, 1, "正文后仅单次核对标题，不能轮询");
      assert.strictEqual(titleReads, 1, "只读取当前唯一可见框一次");
      assert.strictEqual(titleElements[1]["data-ebao-article-title"], "true", "React 替换后应重标记当前输入框");
      assert.strictEqual(titleElements[0].value, "旧值");
      titleElements[1].value = "测试";
      await assert.rejects(tools.verifyVisibleArticleTitle(titlePage, "测试标题"), /文章标题与待发布标题不一致/u);
      titleElements[1].value = "测试标题";
      const duplicateTitlePage = { ...titlePage,
        evaluate: async (callback, ...args) => {
          global.document = { querySelectorAll: selector => selector === "[data-ebao-article-title]"
            ? [originalTitle, titleElements[1]] : [titleElements[1], {
              value: "测试标题", getBoundingClientRect: () => ({ width: 420, height: 40 }),
            }] };
          return callback(...args);
        },
      };
      await assert.rejects(tools.verifyVisibleArticleTitle(duplicateTitlePage, "测试标题"), /文章标题与待发布标题不一致/u);
      await assert.rejects(tools.fillArticleTitle({ ...titlePage,
        evaluate: async (callback, ...args) => {
          global.document = { querySelectorAll: () => [titleElements[1], {
            getBoundingClientRect: () => ({ width: 420, height: 40 }),
          }] };
          return callback(...args);
        },
      }, "测试标题", { stableVisible: true }), /标题输入框未能唯一定位/u);
      const legacyTitleCalls = [];
      const legacyTitlePage = {
        waitForSelector: async () => {},
        click: async () => {},
        keyboard: { press: async () => {} },
        type: async (_selector, title, options) => legacyTitleCalls.push({ title, options }),
        $eval: async () => "测试标题",
      };
      await tools.fillArticleTitle(legacyTitlePage, "测试标题");
      assert.deepStrictEqual(legacyTitleCalls, [{ title: "测试标题", options: { delay: 25 } }]);
      await assert.rejects(tools.fillArticleTitle({ ...legacyTitlePage, $eval: async () => "测试" },
        "测试标题"), /文章标题未写入/u);
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
      responses.emit("response", saveResponse("<p>完整测试正文</p>", 0));
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual((await save.waitForFullBodySave(1)).confirmed, true);
      assert.strictEqual((await tools.confirmToutiaoDraftAutosave(draftList(true), "测试标题", 1, save)).confirmed, true);
      assert.strictEqual((await tools.confirmToutiaoDraftAutosave(draftList(false), "测试标题", 1, save)).confirmed, false);
      assert.strictEqual((await tools.confirmToutiaoDraftAutosave(draftList("测试标题加后缀"), "测试标题", 1, save)).confirmed, false);
      const articleTitleControl = ({ value = "测试标题", width = 420, height = 40,
        visibility = "visible", disabled = false, ariaDisabled = false, marked = false } = {}) => ({
        value, visibility, disabled,
        getBoundingClientRect: () => ({ width, height }),
        getAttribute: name => name === "aria-disabled" ? String(ariaDisabled)
          : name === "data-ebao-article-title" && marked ? "true" : "",
      });
      const reopenedDraft = ({ body = "开头文字不可丢失的中段结尾文字",
        titleCount = 1, currentUrl = "", editId = "draft-1", editorTitles = [{}] } = {}) => {
        const editUrl = `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${editId}`;
        const titleNode = () => ({
          textContent: "测试标题", children: [],
          getBoundingClientRect: () => ({ width: 120, height: 25 }),
        });
        const editPage = {
          url: () => currentUrl || editUrl,
          waitForSelector: async () => {},
          evaluate: async () => "[data-ebao-article-editor='true']",
          waitForFunction: async (callback, _options, ...args) => {
            const titleInputs = editorTitles.map(articleTitleControl);
            global.document = { querySelectorAll: selector => selector.includes("placeholder") ? titleInputs : [],
              querySelector: selector => selector === "[data-ebao-article-editor='true']"
              ? { textContent: body, querySelectorAll: () => [] }
                : selector.includes("placeholder") ? titleInputs[0] : null };
            global.location = { href: editUrl };
            const previousComputedStyle = global.getComputedStyle;
            global.getComputedStyle = element => ({ visibility: element.visibility || "visible" });
            try { if (!callback(...args)) throw new Error("reopened draft mismatch"); }
            finally { global.getComputedStyle = previousComputedStyle; }
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
        let directEdit = false;
        const visits = [];
        return {
          visits,
          url: () => directEdit ? editPage.url() : "https://mp.toutiao.com/profile_v4/manage/draft",
          goto: async url => { visits.push(url); directEdit = Boolean(tools.canonicalToutiaoDraftUrl(url)); },
          waitForSelector: async (...args) => editPage.waitForSelector(...args),
          waitForFunction: async (callback, _options, ...args) => {
            if (directEdit) return editPage.waitForFunction(callback, _options, ...args);
            global.document = { querySelectorAll: () => Array.from({ length: titleCount }, titleNode) };
            if (!callback(...args)) throw new Error("draft title mismatch");
          },
          evaluate: async (...args) => directEdit ? editPage.evaluate(...args) : { marked: true, editHref: editUrl },
          browser: () => browser,
          click: async selector => { assert.strictEqual(selector, "[data-ebao-draft-edit='true']"); },
        };
      };
      const reopenOptions = { expectedHtml: "<p>开头文字</p><p>不可丢失的中段</p><p>结尾文字</p>" };
      assert.deepStrictEqual(await tools.confirmToutiaoDraftAutosave(reopenedDraft(), "测试标题", 1,
        save, reopenOptions), { confirmed: true, draftUrl:
          "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=draft-1" });
      assert.match((await tools.confirmToutiaoDraftAutosave(reopenedDraft({ currentUrl:
        "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=draft-2" }), "测试标题", 1,
        save, reopenOptions)).reason, /ID 与目标草稿不一致/u);
      assert.match((await tools.confirmToutiaoDraftAutosave(reopenedDraft({ body: "开头文字结尾文字" }),
        "测试标题", 1, save, reopenOptions)).reason, /未确认完整正文/u);
      assert.strictEqual((await tools.confirmToutiaoDraftAutosave(reopenedDraft({ titleCount: 2 }),
        "测试标题", 1, save, reopenOptions)).confirmed, false);
      assert.strictEqual((await tools.confirmToutiaoDraftAutosave(reopenedDraft({ editorTitles: [
        { value: "旧标题", width: 0, height: 0, marked: true }, {},
      ] }), "测试标题", 1, save, reopenOptions)).confirmed, true,
      "重开草稿应跳过首个带旧标记的隐藏标题，核对唯一可见标题");
      for (const editorTitles of [[{}, {}], [{ width: 0, height: 0, marked: true }],
        [{ visibility: "hidden" }], [{ disabled: true }], [{ ariaDisabled: true }], [{ value: "其他标题" }]]) {
        assert.strictEqual((await tools.confirmToutiaoDraftAutosave(reopenedDraft({ editorTitles }),
          "测试标题", 1, save, reopenOptions)).confirmed, false,
        "重开草稿标题不唯一、隐藏、禁用或不匹配时不能确认保存成功");
      }
      const verifiedSave = async ({ requestId = "", receipt = {}, html = reopenOptions.expectedHtml } = {}) => {
        const events = new EventEmitter();
        const observer = tools.observeToutiaoDraftSave(events);
        observer.expect("测试标题", "开头文字不可丢失的中段结尾文字", reopenOptions.expectedHtml);
        const response = saveResponse(html, 0, { pgcId: requestId });
        response.json = async () => ({ code: 0, ...receipt });
        events.emit("response", response);
        await new Promise(resolve => setImmediate(resolve));
        return { observer, events, saved: await observer.waitForFullBodySave(1) };
      };
      for (const input of [
        { requestId: "draft-1", expectedId: "draft-1" },
        { receipt: { pgc_id: "draft-1" }, expectedId: "draft-1" },
        { receipt: { data: { pgc_id: "draft-1" } }, expectedId: "draft-1" },
        { receipt: { data: { pgc_id: "7570000000000000001" } }, expectedId: "7570000000000000001" },
        { receipt: { data: { pgc_id: 123 } }, expectedId: "123" },
      ]) {
        const { observer, saved } = await verifiedSave(input);
        const expectedUrl = `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${input.expectedId}`;
        assert.deepStrictEqual(saved, { confirmed: true, draftUrl: expectedUrl });
        const duplicateTitles = reopenedDraft({ titleCount: 2, editId: input.expectedId });
        assert.deepStrictEqual(await tools.confirmToutiaoDraftAutosave(duplicateTitles,
          "测试标题", 1, observer, reopenOptions), { confirmed: true, draftUrl: expectedUrl },
        "保存回执有稳定 ID 时同标题两篇草稿仍可精确重开核验");
        assert.deepStrictEqual(duplicateTitles.visits, [expectedUrl], "有保存 ID 时不得挑选同标题列表中的草稿");
        assert.match((await tools.confirmToutiaoDraftAutosave(reopenedDraft({ currentUrl:
          "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=wrong-draft" }),
        "测试标题", 1, observer, reopenOptions)).reason, /ID 与目标草稿不一致/u);
        assert.match((await tools.confirmToutiaoDraftAutosave(reopenedDraft({ body: "开头文字结尾文字",
          editId: input.expectedId }), "测试标题", 1, observer, reopenOptions)).reason, /未确认完整正文/u);
        observer.stop();
      }
      for (const receipt of [
        { data: { pgc_id: Number.MAX_SAFE_INTEGER + 1 } },
        { data: { pgc_id: "0" } },
        { data: { pgc_id: "bad/id" } },
        { data: { article_id: "draft-1" } },
      ]) {
        const { observer, saved } = await verifiedSave({ receipt });
        assert.deepStrictEqual(saved, { confirmed: true }, "不安全或非标准字段不得产生可信草稿地址");
        assert.strictEqual((await tools.confirmToutiaoDraftAutosave(reopenedDraft({ titleCount: 2 }),
          "测试标题", 1, observer, reopenOptions)).confirmed, false, "缺可信 ID 的同标题歧义必须保留未确认");
        observer.stop();
      }
      const conflictingId = await verifiedSave({ requestId: "draft-1", receipt: { data: { pgc_id: "draft-2" } } });
      assert.strictEqual(conflictingId.saved.confirmed, false);
      assert.match(conflictingId.saved.reason, /草稿 ID 不一致/u);
      conflictingId.observer.stop();
      const incompleteId = await verifiedSave({ receipt: { data: { pgc_id: "draft-1" } },
        html: "<p>开头文字</p><p>结尾文字</p>" });
      assert.strictEqual(incompleteId.saved.confirmed, false, "不完整正文的成功回执不能提供可信 ID");
      assert.strictEqual(incompleteId.saved.draftUrl, undefined);
      incompleteId.observer.stop();
      const lateEvents = new EventEmitter();
      const lateSave = tools.observeToutiaoDraftSave(lateEvents);
      lateSave.expect("测试标题", "完整测试正文", "<p>完整测试正文</p>");
      let finishLateResponse;
      const lateResponse = saveResponse("<p>完整测试正文</p>", 0);
      lateResponse.json = () => new Promise(resolve => { finishLateResponse = resolve; });
      lateEvents.emit("response", lateResponse);
      lateSave.expect("测试标题", "新版完整测试正文", "<p>新版完整测试正文</p>");
      finishLateResponse({ code: 0, data: { pgc_id: "old-draft" } });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual((await lateSave.waitForFullBodySave(1)).confirmed, false,
        "重设最终正文期望后，先前尚未返回的回执不能绑定新稿件");
      lateSave.stop();
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
      const titleFailures = [];
      let titleCheckCount = 0;
      let failTitleCheck = 0;
      let publishClicks = 0;
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
          titleCheckCount = 0;
          sequence.push("title"); return "#title";
        },
        verifyVisibleArticleTitle: async (_page, title) => {
          assert.strictEqual(title, "测试标题");
          sequence.push("title-check");
          titleCheckCount++;
          if (titleCheckCount === failTitleCheck) throw new Error("文章标题与待发布标题不一致");
          return "#title";
        },
        renderUploadedArticle: () => "<p>完整测试正文</p>",
        pasteArticleHtml: async (_page, _editor, _html, _plain, _context, _images, options) => {
          assert.deepStrictEqual(options, { preferKeyboardForPlain: true, verifyWholeBody: true });
          assert.deepStrictEqual(_images, []);
          sequence.push("body");
        },
        confirmToutiaoBodyAccepted: async () => { sequence.push("word-count"); },
        fillArticleMetadata: async () => { sequence.push("metadata"); },
        currentUrl: () => before,
        confirmToutiaoDraftAutosave: async (_page, _title, _timeout, _observer, options) => {
          sequence.push("draft-save");
          saveOptions.push(options);
          return { confirmed: true };
        },
        captureArticleNotices: async () => { sequence.push("notices"); return []; },
        clickArticleAction: async () => { publishClicks++; sequence.push("publish"); },
        confirmPlatformOutcome: async () => { sequence.push("publish-outcome"); return true; },
        finishArticle: async () => { sequence.push("finished"); },
        failArticle: async (_page, _data, _window, _event, error, clicked) => {
          sequence.push("failed");
          titleFailures.push({ message: error.message, clicked });
        },
      };
      const draftPage = { click: async selector => {
        assert.strictEqual(selector, "#title");
        sequence.push("blur");
      } };
      const draftData = { publishToDraft: true, data: { title: "测试标题", content: "完整测试正文", images: [] } };
      await publishToutiaoArticle(draftPage, draftData, null, null);
      assert.deepStrictEqual(sequence, ["expect", "title", "expect-html:<p>完整测试正文</p>",
        "body", "word-count", "title-check", "blur", "metadata", "title-check", "draft-save", "finished", "stop"]);
      assert.deepStrictEqual(saveOptions.at(-1), { expectedHtml: "<p>完整测试正文</p>" });
      sequence.length = 0;
      await publishToutiaoArticle({
        ...draftPage,
        click: async () => { throw new Error("stale title marker"); },
        evaluate: async () => { sequence.push("blur-fallback"); },
      }, draftData, null, null);
      assert.deepStrictEqual(sequence, ["expect", "title", "expect-html:<p>完整测试正文</p>",
        "body", "word-count", "title-check", "blur-fallback", "metadata", "title-check", "draft-save", "finished", "stop"]);
      sequence.length = 0;
      global.__ttAdapterMocks.confirmToutiaoDraftAutosave = async () => {
        sequence.push("draft-save");
        return { confirmed: false, reason: "完整正文保存未确认" };
      };
      await publishToutiaoArticle(draftPage, draftData, null, null);
      assert.deepStrictEqual(sequence, ["expect", "title", "expect-html:<p>完整测试正文</p>",
        "body", "word-count", "title-check", "blur", "metadata", "title-check", "draft-save", "failed", "stop"]);
      sequence.length = 0;
      global.__ttAdapterMocks.confirmToutiaoDraftAutosave = async (_page, _title, _timeout, _observer, options) => {
        sequence.push("draft-save");
        saveOptions.push(options);
        return { confirmed: true };
      };
      const manualContent = "开头文字\n\n【配图 1：图片 A，请在头条后台手动上传】\n\n结尾文字";
      const manualDraftData = { ...draftData, data: { ...draftData.data, content: manualContent } };
      const manualHtml = tools.renderUploadedArticle(manualDraftData, {});
      assert.match(manualHtml, /配图 1：图片 A，请在头条后台手动上传/u);
      assert.doesNotMatch(manualHtml, /<img\b|ebao-asset:\/\//u, "手动配图占位不得生成上传 URL 或远端图片");
      const normalRender = global.__ttAdapterMocks.renderUploadedArticle;
      global.__ttAdapterMocks.renderUploadedArticle = (data, uploaded) => {
        assert.deepStrictEqual(uploaded, {}, "头条手动草稿不会自动上传正文或封面");
        return tools.renderUploadedArticle(data, uploaded);
      };
      await publishToutiaoArticle(draftPage, manualDraftData, null, null);
      assert.deepStrictEqual(sequence, ["expect", "title", `expect-html:${manualHtml}`,
        "body", "word-count", "title-check", "blur", "metadata", "title-check", "draft-save", "finished", "stop"]);
      assert.deepStrictEqual(saveOptions.at(-1), { expectedHtml: manualHtml });
      global.__ttAdapterMocks.renderUploadedArticle = normalRender;
      const publishPage = { ...draftPage,
        waitForTimeout: async timeout => { assert.strictEqual(timeout, 600); sequence.push("preview-delay"); },
        evaluate: async () => false,
      };
      const publishData = { ...draftData, publishToDraft: false };
      sequence.length = 0;
      await publishToutiaoArticle(publishPage, publishData, null, null);
      assert.deepStrictEqual(sequence, ["title", "body", "word-count", "title-check", "blur", "metadata",
        "notices", "title-check", "publish", "preview-delay", "publish-outcome", "finished"]);
      assert.strictEqual(publishClicks, 1);
      // 标题有丢字时正文仍先写入；正文后和提交前任一核对失败，都不能点击发布。
      for (const failedCheck of [1, 2]) {
        sequence.length = 0;
        publishClicks = 0;
        failTitleCheck = failedCheck;
        await publishToutiaoArticle(publishPage, publishData, null, null);
        assert.deepStrictEqual(sequence, failedCheck === 1
          ? ["title", "body", "word-count", "title-check", "failed"]
          : ["title", "body", "word-count", "title-check", "blur", "metadata", "notices", "title-check", "failed"]);
        assert.strictEqual(publishClicks, 0, "标题错误不能点发布");
        assert.deepStrictEqual(titleFailures.at(-1), { message: "文章标题与待发布标题不一致", clicked: false });
      }
      failTitleCheck = 0;
      delete global.__ttAdapterMocks;

      const originalDataTransfer = global.DataTransfer;
      const originalClipboardEvent = global.ClipboardEvent;
      const originalWindow = global.window;
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
        global.window = originalWindow;
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

      const image = path.join(temporary, "test.png");
      fs.writeFileSync(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
      assert.deepStrictEqual(Object.keys(upload).sort(), ["selectBaijiahaoCover", "uploadBaijiahaoImage"],
        "上传模块只保留百家号正文上传与封面选择");
      assert.deepStrictEqual(Object.keys(productionUpload).sort(), Object.keys(upload).sort());
      let baijiahaoRequests = 0;
      assert.strictEqual(await productionUpload.uploadBaijiahaoImage({
        evaluate: async (callback, ...args) => executeBrowserFunction(callback, {
          atob, Blob,
          FormData: class {
            constructor() { this.entries = new Map(); }
            append(name, value) { this.entries.set(name, value); }
          },
          fetch: async (route, request) => {
            baijiahaoRequests++;
            assert.strictEqual(route, "/pcui/picture/uploadproxy");
            assert.strictEqual(request.method, "POST");
            assert.strictEqual(request.body.entries.get("media").type, "image/png");
            return { ok: true, json: async () => ({ errno: 0, errmsg: "success",
              ret: { https_url: "https://example.com/baijiahao.png" } }) };
          },
        }, args),
      }, { path: image, mime: "image/png" }), "https://example.com/baijiahao.png",
      "百家号注入回调也只依赖浏览器 globals，不依赖被编译提升的 async helper");
      assert.strictEqual(baijiahaoRequests, 1, "仅使用离线 fetch fixture，不发平台请求");
      const baijiahaoCoverUrl = "https://example.com/baijiahao.png";
      const coverChoiceAttributes = {};
      const baijiahaoCoverSteps = [];
      let coverImages = [];
      const baijiahaoCoverArea = {
        click: () => baijiahaoCoverSteps.push("open"),
        querySelectorAll: () => coverImages,
      };
      const coverConfirm = {
        textContent: "确定", disabled: false, getAttribute: () => "",
        getBoundingClientRect: () => ({ width: 80, height: 30 }),
        click: () => {
          baijiahaoCoverSteps.push("confirm");
          coverImages = [{ src: baijiahaoCoverUrl }];
        },
      };
      let coverButtons = [coverConfirm];
      const coverDialog = {
        parentElement: null,
        matches: () => true,
        querySelectorAll: () => coverButtons,
        getBoundingClientRect: () => ({ width: 400, height: 300 }),
        setAttribute: (name, value) => { coverChoiceAttributes[name] = value; },
        removeAttribute: name => { delete coverChoiceAttributes[name]; },
      };
      const coverImage = {
        src: baijiahaoCoverUrl, parentElement: coverDialog,
        getBoundingClientRect: () => ({ width: 160, height: 100 }),
        click: () => baijiahaoCoverSteps.push("select-image"),
      };
      let pickerImages = [coverImage];
      const baijiahaoCoverDocument = {
        body: {},
        querySelector: selector => selector === "#cover-tabs-container" ? baijiahaoCoverArea
          : coverChoiceAttributes["data-ebao-cover-choice-panel"] ? coverDialog : null,
        querySelectorAll: selector => selector === "[data-ebao-cover-choice-panel]"
          ? coverChoiceAttributes["data-ebao-cover-choice-panel"] ? [coverDialog] : [] : pickerImages,
      };
      const baijiahaoCoverPage = {
        evaluate: async (callback, ...args) => executeBrowserFunction(callback,
          { document: baijiahaoCoverDocument }, args),
        waitForFunction: async (callback, _options, ...args) => {
          assert.strictEqual(executeBrowserFunction(callback, { document: baijiahaoCoverDocument }, args), true);
        },
      };
      await productionUpload.selectBaijiahaoCover(baijiahaoCoverPage, baijiahaoCoverUrl);
      assert.deepStrictEqual(baijiahaoCoverSteps, ["open", "select-image", "confirm"],
        "百家号既有封面选择及最终显示核对必须保留，生产注入函数不依赖模块闭包");
      baijiahaoCoverSteps.length = 0;
      pickerImages = [coverImage, { ...coverImage }];
      await assert.rejects(productionUpload.selectBaijiahaoCover(baijiahaoCoverPage, baijiahaoCoverUrl),
        /封面素材未出现在平台素材库/u);
      assert.deepStrictEqual(baijiahaoCoverSteps, ["open"], "百家号同 URL 多图时不能任意挑选");
      baijiahaoCoverSteps.length = 0;
      pickerImages = [coverImage];
      coverButtons = [coverConfirm, { ...coverConfirm }];
      await assert.rejects(productionUpload.selectBaijiahaoCover(baijiahaoCoverPage, baijiahaoCoverUrl),
        /平台封面选择未确认/u);
      assert.deepStrictEqual(baijiahaoCoverSteps, ["open", "select-image"], "百家号确认按钮有歧义时不得点击");
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
