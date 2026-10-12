"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const webpack = require("webpack");
const { build } = require("esbuild");
const MarkdownIt = require("markdown-it");

const root = path.join(__dirname, "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ebao-dy-article-test-"));
const ENTRY = "https://creator.douyin.com/creator-micro/content/upload?default-tab=5";
const EDITOR = "https://creator.douyin.com/creator-micro/content/post/article?enter_from=publish_page&media_type=article&type=new";
const DRAFT = "https://creator.douyin.com/creator-micro/content/post/article?enter_from=draft&creation_id=draft-123&init_timestamp=1791520000";
const FULL_BODY = "开头完整正文\n\n中间完整正文\n\n结尾完整正文";
const SUMMARY = "完整文章摘要";

const stubs = {
  "./articleWebTools.js": `export function renderUploadedArticle(data) { return globalThis.__dyArticleRender(data.data.content); }
    export async function pasteArticleHtml(page, selector, html, plain, context, images, options) {
      if (!options.verifyWholeBody || options.preferKeyboardForPlain || images.length) throw new Error('unsafe body options');
      await page.evaluate((marker, rich) => { document.querySelector(marker).innerHTML = rich; }, selector, html);
    }`,
  "./publishOutcome.js": `export function readPageUrl(page) { return page.url(); }
    export async function replyPublishFailure({data, event, message, window, closeWindow}) {
      event.reply('puppeteerFile-done', {...data,status:false,outcome:'failed',message});
      if(closeWindow) window.close();
    }`,
  "./failureScreenshot.js": "export async function capturePublishFailureScreenshot() { return ''; }",
};

function element(text = "", { width = 400, height = 100, attrs = {} } = {}) {
  return { textContent: text, innerText: text, attrs, disabled: false,
    getBoundingClientRect: () => ({ width, height }),
    getAttribute: name => attrs[name] ?? null, setAttribute: (name, value) => { attrs[name] = value; },
    removeAttribute: name => { delete attrs[name]; }, closest: () => null,
    querySelector: () => null, querySelectorAll: () => [], tagName: "DIV" };
}

function htmlRoot(html) {
  const tree = { tagName: "BODY", nodes: [], parent: null };
  let current = tree;
  const decode = text => text.replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&#39;/gu, "'");
  for (const token of html.match(/<[^>]+>|[^<]+/gu) || []) {
    if (/^<\//u.test(token)) current = current.parent || tree;
    else if (/^</u.test(token)) {
      const name = /^<([a-z0-9]+)/iu.exec(token)?.[1].toUpperCase();
      if (!name) continue;
      const node = { tagName: name, nodes: [], parent: current, attrs: {} };
      for (const attr of token.matchAll(/([a-z-]+)="([^"]*)"/giu)) node.attrs[attr[1]] = decode(attr[2]);
      current.nodes.push(node);
      if (!["IMG", "BR", "HR"].includes(name)) current = node;
    } else current.nodes.push(decode(token));
  }
  const decorate = node => {
    for (const child of node.nodes) if (typeof child !== "string") decorate(child);
    Object.defineProperty(node, "textContent", { get: () => node.nodes.map(child => typeof child === "string" ? child : child.textContent).join("") });
    node.querySelectorAll = selector => {
      const tags = selector.toUpperCase().split(",");
      const all = [];
      const visit = root => { for (const child of root.nodes) if (typeof child !== "string") { if (tags.includes(child.tagName)) all.push(child); visit(child); } };
      visit(node); return all;
    };
    node.querySelector = selector => node.querySelectorAll(selector)[0] || null;
    node.getAttribute = name => node.attrs[name] || null;
  };
  decorate(tree);
  return tree;
}

function fixture({
  mode = "draft", startUrl = ENTRY, noEntry = false, multipleEntry = false, noTitle = false, noBody = false,
  hidden = false, multipleTitle = false, initial = false, titleLimit = 30, noAction = false, multipleAction = false,
  disabledAction = false, staleReceipt = false, noHint = false, wrongHint = false, multipleHint = false,
  draftUrl = DRAFT, persistence = "full", result = "success", paste = "full", clickError = false, hintDelay = 0, loadDelay = 0,
  autosave = "success", expectedBody = FULL_BODY,
  noSummary = false, multipleSummary = false, summaryHidden = false, summaryLimit = 30, initialSummary = "",
  summaryPaste = "full", expectedSummary = "",
} = {}) {
  let url = startUrl;
  let stage = startUrl === ENTRY ? "entry" : "editor";
  let active = "";
  let bodyHtml = initial ? "<p>原稿正文</p>" : "<p></p>";
  let savedHtml = "";
  let savedSummary = "";
  let hintReads = 0;
  let bodyReads = 0;
  let reopened = false;
  let targetDraftHtml = "";
  let targetDraftSummary = "";
  const actions = [];
  const waits = [];
  const listeners = new Map();
  let autosaveEmitted = false;
  const title = { ...element("", hidden ? { width: 0 } : {}), value: initial ? "原稿" : "", maxLength: titleLimit };
  const summary = { ...element("", summaryHidden ? { width: 0 } : {}), value: initialSummary, maxLength: summaryLimit };
  const body = element("", { width: hidden ? 0 : 400, height: 200 });
  Object.defineProperty(body, "innerHTML", { get: () => bodyHtml, set: value => { bodyHtml = paste === "truncated" ? "<p>开头完整正文</p>" : value; } });
  Object.defineProperty(body, "textContent", { get: () => {
    if (reopened && loadDelay && bodyReads++ >= loadDelay) { bodyHtml = targetDraftHtml; title.value = "文章标题"; summary.value = targetDraftSummary; }
    return htmlRoot(bodyHtml).textContent;
  } });
  body.querySelectorAll = selector => htmlRoot(bodyHtml).querySelectorAll(selector);
  body.querySelector = selector => htmlRoot(bodyHtml).querySelector(selector);
  const entry = element("我要发文");
  const action = element(mode === "draft" ? "暂存离开" : "发布");
  action.disabled = disabledAction;
  const hint = element(wrongHint ? "你还有上次未发布的视频，是否继续编辑？" : "你还有上次未发布的文章，是否继续编辑？");
  const continuation = element("继续编辑");
  continuation.closest = selector => selector.includes("form-hint") ? hint : null;
  const window = { destroyed: false, showCount: 0, isDestroyed() { return this.destroyed; },
    close() { this.destroyed = true; actions.push("close"); }, show() { this.showCount++; }, focus() {} };
  const document = {
    querySelectorAll(selector) {
      if (selector.includes("请输入文章标题")) return stage === "editor" && !noTitle ? multipleTitle ? [title, { ...title }] : [title] : [];
      if (selector.includes("添加内容摘要或文章精彩部分")) return stage === "editor" && !noSummary && !(reopened && persistence === "missing-summary-field") ? multipleSummary ? [summary, { ...summary }] : [summary] : [];
      if (selector.startsWith("#DCPF")) return stage === "editor" && !noBody ? [body] : [];
      if (selector.includes("[role=\"alert\"]")) {
        if (staleReceipt || stage === "published") return [element("发布成功")];
        if (stage === "failed") return [element(result === "short-body" ? "正文内容不能少于100字" : "发布失败")];
        return [];
      }
      if (selector.startsWith('[class*="hint-text"]')) return stage === "saved-entry" && !noHint && hintReads++ >= hintDelay ? multipleHint ? [continuation, {...continuation}] : [continuation] : [];
      if (selector === 'button,[role="button"]') {
        if (stage === "entry") return noEntry ? [] : multipleEntry ? [entry, {...entry}] : [entry];
        if (stage === "editor") return noAction ? [] : multipleAction ? [action, {...action}] : [action];
        return [];
      }
      const names = [...selector.matchAll(/\[([a-z-]+)(?:="true")?\]/gu)].map(match => match[1]);
      return [title, body, summary, entry, action, continuation].filter(item => names.some(name => item.attrs[name]));
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
  };
  const page = {
    on(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    off(name, callback) { listeners.get(name)?.delete(callback); },
    async emit(name, value) { await Promise.all([...(listeners.get(name) || [])].map(callback => callback(value))); },
    url: () => url,
    async evaluate(callback, ...args) {
      return vm.runInNewContext("(" + callback.toString() + ")(...__args)", {
        document, __args: args, location: new URL(url), URL,
        getComputedStyle: () => ({ visibility: "visible" }), DOMParser: class { parseFromString(html) { return { body: htmlRoot(html) }; } },
      });
    },
    async waitForSelector(selector) { if (!document.querySelector(selector)) throw new Error("editor unavailable"); },
    async waitForFunction(callback, _options, ...args) { if (!await this.evaluate(callback, ...args)) throw new Error("navigation unconfirmed"); },
    async waitForTimeout(ms) {
      waits.push(ms);
      if (autosaveEmitted || stage !== "editor" || !title.value || !htmlRoot(bodyHtml).textContent.trim()) return;
      autosaveEmitted = true;
      const fullBody = expectedBody;
      const draft = { req_type: 0, title: title.value, long_article: fullBody,
        creation_id: "draft-123", init_timestamp: 1791520000,
        ...(expectedSummary ? { description: expectedSummary } : {}) };
      if (autosave === "missing-summary") delete draft.description;
      if (autosave === "wrong-summary") draft.description = "其他摘要";
      if (autosave === "truncated-summary") draft.description = expectedSummary.slice(0, 1);
      if (autosave === "nonstring-summary") draft.description = { text: expectedSummary };
      if (autosave === "summary-wrong-field") { delete draft.description; draft.summary = expectedSummary; }
      if (autosave === "title-only") draft.long_article = "";
      if (autosave === "truncated") draft.long_article = "开头完整正文";
      if (autosave === "merged") draft.long_article = "开头完整正文中间完整正文结尾完整正文";
      if (autosave === "reordered") draft.long_article = "结尾完整正文\n\n中间完整正文\n\n开头完整正文";
      if (autosave === "wrong-title") draft.title = "其他标题";
      if (autosave === "partial-title") draft.title = title.value.slice(0, 1);
      if (autosave === "format-loss") draft.long_article = fullBody.replace(/\*\*/gu, "");
      if (autosave === "missing-identity") delete draft.creation_id;
      if (autosave === "query-only") draft.req_type = 3;
      if (autosave === "unknown-schema") draft.req_type = "0";
      if (autosave === "different-endpoint-unknown-schema") draft.req_type = "unknown-write";
      const request = { url: () => `https://${autosave === "wrong-origin" ? "evil.example" : "creator.douyin.com"}${autosave === "wrong-path" ? "/web/api/media/aweme/new-draft/" : "/web/api/media/aweme/draft/"}`,
        method: () => "POST", postData: () => autosave === "bad-request" ? "{invalid" : JSON.stringify({ item: { common: { draft } } }) };
      const response = { request: () => request, status: () => autosave === "http-error" ? 503 : 200,
        json: async () => {
          if (autosave === "bad-response") throw new Error("invalid response");
          if (autosave === "failure-during-json") await page.emit("requestfailed", request);
          return { status_code: autosave === "rejected" ? 8 : autosave === "text-code" ? "0" : 0,
            ...(autosave === "wrong-response-identity" ? { draft: { creation_id: "other-draft", init_timestamp: draft.init_timestamp } } : {}),
            ...(["wrong-response-summary", "nonstring-response-summary", "matching-response-summary", "identity-only-response"].includes(autosave)
              ? { draft: { creation_id: draft.creation_id, init_timestamp: draft.init_timestamp,
                ...(autosave === "identity-only-response" ? {} : { description: autosave === "nonstring-response-summary" ? 7
                  : autosave === "wrong-response-summary" ? "其他摘要" : expectedSummary }) } } : {}) };
        } };
      if (autosave === "no-slash") request.url = () => "https://creator.douyin.com/web/api/media/aweme/draft";
      if (autosave === "different-endpoint-unknown-schema") request.url = () => "https://creator.douyin.com/web/api/media/aweme/SecretTokenAbc?msToken=must-not-appear";
      if (["unrelated-save-only", "unrelated-draft-only"].includes(autosave)) {
        request.url = () => autosave === "unrelated-save-only"
          ? "https://creator.douyin.com/web/api/media/aweme/save/imagex"
          : "https://creator.douyin.com/web/api/media/shop/draft/update/";
        request.postData = () => JSON.stringify({ img_url: "https://example.com/image.jpg", draft_id: "video-draft" });
      }
      if (autosave === "no-request") return;
      if (autosave !== "stale-response") await page.emit("request", request);
      if (autosave === "network-error") { await page.emit("requestfailed", request); return; }
      if (autosave === "no-response") return;
      if (["unrelated-save-after-ack", "unrelated-draft-after-ack", "different-endpoint-read-after-ack"].includes(autosave)) {
        await page.emit("response", response);
        const unrelated = { ...request,
          url: () => autosave === "unrelated-save-after-ack" ? "https://creator.douyin.com/web/api/media/aweme/save/imagex"
            : autosave === "unrelated-draft-after-ack" ? "https://creator.douyin.com/web/api/media/shop/draft/update/"
              : "https://creator.douyin.com/web/api/media/aweme/new-draft/",
          postData: () => autosave === "different-endpoint-read-after-ack"
            ? JSON.stringify({ item: { common: { draft: { req_type: 3 } } } })
            : JSON.stringify({ img_url: "https://example.com/image.jpg", draft_id: "video-draft" }),
        };
        await page.emit("request", unrelated);
        await page.emit("response", { ...response, request: () => unrelated });
        savedHtml = globalThis.__dyArticleRender(fullBody);
        savedSummary = expectedSummary;
        return;
      }
      if (["newer-pending", "newer-title-only", "newer-changed-endpoint", "newer-unknown-schema", "newer-success", "newer-missing-summary"].includes(autosave)) {
        const newer = { ...request, postData: () => JSON.stringify({ item: { common: { draft:
          { ...draft, long_article: autosave === "newer-title-only" ? "" : fullBody } } } }) };
        if (autosave === "newer-changed-endpoint") {
          newer.url = () => "https://creator.douyin.com/web/api/media/aweme/SecretTokenAbc?msToken=must-not-appear";
          newer.postData = () => JSON.stringify({ item: { common: { draft: { ...draft, token: "BodySecretToken" } } } });
        }
        if (autosave === "newer-unknown-schema") newer.postData = () => JSON.stringify({ item: { common: {} } });
        if (autosave === "newer-missing-summary") newer.postData = () => JSON.stringify({ item: { common: { draft: { ...draft, description: "" } } } });
        if (["newer-success", "newer-changed-endpoint", "newer-unknown-schema", "newer-missing-summary"].includes(autosave)) await page.emit("response", response);
        await page.emit("request", newer);
        await page.emit("response", response);
        if (autosave === "newer-title-only") await page.emit("response", { ...response, request: () => newer });
        if (autosave === "newer-success") {
          await page.emit("response", { ...response, request: () => newer });
          savedHtml = globalThis.__dyArticleRender(fullBody);
          savedSummary = expectedSummary;
        }
        return;
      }
      await page.emit("response", response);
      if (["success", "no-slash", "matching-response-summary", "identity-only-response"].includes(autosave)) {
        savedHtml = globalThis.__dyArticleRender(fullBody);
        savedSummary = expectedSummary;
      }
    },
    async click(selector) {
      if (selector.includes("-entry=")) { actions.push("enter"); stage = "editor"; url = EDITOR; return; }
      if (selector.includes("-title=")) { active = "title"; return; }
      if (selector.includes("-summary=")) { active = "summary"; return; }
      if (selector.includes("-body=")) { active = "body"; return; }
      if (selector.includes("-continue=")) {
        actions.push("reopen"); stage = "editor"; url = draftUrl;
        bodyHtml = persistence === "truncated" ? "<p>开头完整正文</p>" : persistence === "reordered" ? "<p>结尾完整正文</p><p>中间完整正文</p><p>开头完整正文</p>" : persistence === "merged" ? "<p>开头完整正文中间完整正文结尾完整正文</p>" : savedHtml;
        if (persistence === "wrong-title") title.value = "错误标题";
        summary.value = persistence === "missing-summary" ? "" : persistence === "wrong-summary" ? "其他摘要"
          : persistence === "truncated-summary" ? savedSummary.slice(0, 1) : savedSummary;
        reopened = true;
        targetDraftHtml = bodyHtml;
        targetDraftSummary = summary.value;
        if (loadDelay) { bodyHtml = "<p></p>"; title.value = ""; summary.value = ""; }
        return;
      }
      if (selector.includes("-action=")) {
        actions.push(mode === "draft" ? "save" : "publish");
        if (clickError) throw new Error("click disconnected");
        if (result === "success" && mode === "draft") { stage = "saved-entry"; url = ENTRY; }
        else if (result === "success") { stage = "published"; url = "https://creator.douyin.com/creator-micro/content/manage?enter_from=publish"; }
        else if (["failure", "short-body"].includes(result)) stage = "failed";
        return;
      }
      throw new Error("Unexpected click " + selector);
    },
    keyboard: {
      async press(key) { if (key === "Backspace" && active === "title") title.value = ""; if (key === "Backspace" && active === "summary") summary.value = ""; },
      async sendCharacter(text) { if (active === "title") title.value = text;
        else if (active === "summary") summary.value = summaryPaste === "truncated" ? text.slice(0, 1) : summaryPaste === "missing" ? "" : text;
        else bodyHtml = `<p>${text}</p>`; },
    },
  };
  return { page, window, actions, waits, listeners };
}

async function run(adapter, settings = {}, override = {}) {
  const environment = fixture({ ...settings, ...(override.data?.content ? { expectedBody: override.data.content } : {}),
    expectedSummary: String(override.data?.summary || "").trim() });
  const replies = [];
  await adapter(environment.page, { taskId: "test", pt: "抖音", publisherWorker: true,
    textType: "article", partition: "persist:testdy", publishToDraft: settings.mode !== "publish",
    data: { title: "文章标题", content: FULL_BODY }, ...override },
  environment.window, { reply: (_channel, payload) => replies.push(payload) });
  assert.strictEqual(replies.length, 1, "必须恰好回执一次");
  assert.ok([...environment.listeners.values()].every(callbacks => callbacks.size === 0), "退出必须解除草稿监听");
  return { ...environment, result: replies[0] };
}

(async () => {
  const markdown = new MarkdownIt({ html: false, linkify: false });
  globalThis.__dyArticleRender = content => markdown.render(content);
  const output = path.join(directory, "adapter.cjs");
  await build({ entryPoints: [path.join(root, "src/main/services/upLoad/dyArticle.js")],
    bundle: true, platform: "node", format: "cjs", outfile: output,
    plugins: [{ name: "dy-article-io-stubs", setup(builder) {
      builder.onResolve({ filter: /.*/u }, args => stubs[args.path] ? { path: args.path, namespace: "stubs" } : null);
      builder.onLoad({ filter: /.*/u, namespace: "stubs" }, args => ({ contents: stubs[args.path], loader: "js" }));
    } }],
  });
  const adapter = require(output);
  assert.strictEqual(adapter.isDouyinArticlePageUrl(ENTRY), true);
  assert.strictEqual(adapter.isDouyinArticlePageUrl(EDITOR), true);
  for (const invalid of [ENTRY.replace("=5", "=4"), ENTRY.replace("=5", "=3"), EDITOR.replace("post/article", "post/video"), ENTRY.replace("creator.douyin.com", "evil.example")]) {
    assert.strictEqual(adapter.isDouyinArticlePageUrl(invalid), false);
    const rejected = await run(adapter.default, { startUrl: invalid });
    assert.strictEqual(rejected.result.outcome, "failed");
    assert.deepStrictEqual(rejected.actions, ["close"], "错误页面不得导航或写入");
  }
  const saved = await run(adapter.default);
  assert.strictEqual(saved.result.outcome, "draft_saved");
  assert.strictEqual(saved.result.draftUrl, DRAFT);
  assert.deepStrictEqual(saved.actions, ["enter", "save", "reopen", "close"]);
  assert.strictEqual(saved.waits[0], 1100, "空白编辑器先等待官方 500ms autosave 基线，但不能把等待当保存成功");
  const summaryData = summary => ({ data: { title: "文章标题", content: FULL_BODY, summary } });
  for (const summary of [SUMMARY, "摘".repeat(30), "   " + SUMMARY + "   "]) {
    const confirmed = await run(adapter.default, { hintDelay: 2, loadDelay: 3 }, summaryData(summary));
    assert.strictEqual(confirmed.result.outcome, "draft_saved", "摘要须经 DOM、description 保存请求和服务端重新回填确认");
  }
  assert.strictEqual((await run(adapter.default, { mode: "publish" }, summaryData(SUMMARY))).result.outcome, "submitted");
  assert.strictEqual((await run(adapter.default, { noSummary: true })).result.outcome, "draft_saved", "旧 payload 未带摘要时可兼容无摘要输入框");
  for (const settings of [{ noSummary: true }, { multipleSummary: true }, { summaryHidden: true },
    { summaryLimit: 2 }, { initialSummary: "已有摘要" }]) {
    const rejected = await run(adapter.default, settings, summaryData(SUMMARY));
    assert.strictEqual(rejected.result.outcome, "failed", JSON.stringify(settings));
    assert.ok(!rejected.actions.some(action => ["save", "publish", "reopen"].includes(action)));
  }
  const existingSummary = await run(adapter.default, { initialSummary: "已有摘要" });
  assert.strictEqual(existingSummary.result.outcome, "failed", "没有 expected summary 也不能覆盖已有摘要的原稿");
  assert.deepStrictEqual(existingSummary.actions, ["enter", "close"]);
  const overlongSummary = await run(adapter.default, {}, summaryData("摘".repeat(31)));
  assert.strictEqual(overlongSummary.result.outcome, "failed");
  assert.deepStrictEqual(overlongSummary.actions, ["close"]);
  for (const summaryPaste of ["truncated", "missing"]) {
    const rejected = await run(adapter.default, { summaryPaste }, summaryData(SUMMARY));
    assert.strictEqual(rejected.result.outcome, "failed");
    assert.match(rejected.result.message, /摘要未完整写入/u);
    assert.strictEqual(rejected.window.destroyed, false);
    assert.ok(!rejected.actions.some(action => ["save", "publish", "reopen"].includes(action)));
  }
  for (const autosave of ["missing-summary", "wrong-summary", "truncated-summary", "nonstring-summary", "summary-wrong-field",
    "wrong-response-summary", "nonstring-response-summary", "newer-missing-summary"]) {
    const rejected = await run(adapter.default, { autosave }, summaryData(SUMMARY));
    assert.strictEqual(rejected.result.outcome, "unknown", autosave);
    assert.strictEqual(rejected.window.destroyed, false);
    assert.ok(!rejected.actions.some(action => ["save", "publish", "reopen"].includes(action)), `${autosave}: 全文已保存但摘要未确认也不得离开或发布`);
  }
  for (const autosave of ["matching-response-summary", "identity-only-response"]) {
    const confirmed = await run(adapter.default, { autosave }, summaryData(SUMMARY));
    assert.strictEqual(confirmed.result.outcome, "draft_saved", "成功回执可不回显摘要，但保存请求和服务端续编摘要必须一致");
  }
  for (const persistence of ["missing-summary", "wrong-summary", "truncated-summary", "missing-summary-field"]) {
    const uncertain = await run(adapter.default, { persistence }, summaryData(SUMMARY));
    assert.strictEqual(uncertain.result.outcome, "unknown", persistence);
    assert.strictEqual(uncertain.window.destroyed, false);
    assert.strictEqual(uncertain.actions.filter(action => action === "save").length, 1, "摘要续编不一致不得重试");
  }
  const delayed = await run(adapter.default, { hintDelay: 4, loadDelay: 6 });
  assert.strictEqual(delayed.result.outcome, "draft_saved", "草稿提示与全文异步回填必须等待");
  const manual = await run(adapter.default, {}, { manualArticleAssets: true });
  assert.strictEqual(manual.result.outcome, "draft_saved");
  assert.strictEqual(manual.window.destroyed, false);
  assert.strictEqual(manual.window._mmRetainedForInspection, true);
  const published = await run(adapter.default, { mode: "publish" });
  assert.strictEqual(published.result.outcome, "submitted");
  assert.strictEqual(published.actions.filter(action => action === "publish").length, 1);
  for (const settings of [{ noEntry: true }, { multipleEntry: true }, { noTitle: true }, { noBody: true },
    { hidden: true }, { multipleTitle: true }, { initial: true }, { titleLimit: 2 }, { staleReceipt: true }]) {
    const rejected = await run(adapter.default, settings);
    assert.strictEqual(rejected.result.outcome, "failed", JSON.stringify(settings));
    assert.ok(!rejected.actions.some(action => ["save", "publish"].includes(action)));
  }
  for (const settings of [{ paste: "truncated" }, { noAction: true }, { multipleAction: true }, { disabledAction: true }]) {
    const rejected = await run(adapter.default, settings);
    assert.strictEqual(rejected.result.outcome, settings.paste === "truncated" ? "failed" : "unknown");
    assert.strictEqual(rejected.window.destroyed, false);
    assert.strictEqual(rejected.window._mmRetainedForInspection, true);
    assert.ok(!rejected.actions.some(action => ["save", "publish"].includes(action)));
  }
  for (const settings of [{ noHint: true }, { wrongHint: true }, { multipleHint: true },
    { draftUrl: DRAFT.replace("creation_id=draft-123", "creation_id=") },
    { draftUrl: DRAFT.replace("creator.douyin.com", "evil.example") },
    { persistence: "truncated" }, { persistence: "reordered" }, { persistence: "merged" },
    { persistence: "wrong-title" }, { result: "pending" }, { clickError: true }]) {
    const uncertain = await run(adapter.default, settings);
    assert.strictEqual(uncertain.result.outcome, "unknown", JSON.stringify(settings));
    assert.strictEqual(uncertain.result.needsAttention, true);
    assert.strictEqual(uncertain.window.destroyed, false);
    assert.strictEqual(uncertain.actions.filter(action => action === "save").length, 1, "保存不确定不得重试");
  }
  const uncertainPublish = await run(adapter.default, { mode: "publish", result: "pending" });
  assert.strictEqual(uncertainPublish.result.outcome, "unknown");
  assert.strictEqual(uncertainPublish.window.destroyed, false);
  const failedPublish = await run(adapter.default, { mode: "publish", result: "failure" });
  assert.strictEqual(failedPublish.result.outcome, "failed");
  assert.strictEqual(failedPublish.window.destroyed, false);
  const shortBody = await run(adapter.default, { mode: "publish", result: "short-body" });
  assert.strictEqual(shortBody.result.outcome, "failed");
  assert.match(shortBody.result.message, /正文内容不能少于100字/u);
  assert.strictEqual(shortBody.actions.filter(action => action === "publish").length, 1);
  for (const autosave of ["no-request", "no-response", "stale-response", "query-only", "title-only", "truncated",
    "merged", "reordered", "wrong-title", "partial-title", "missing-identity", "wrong-origin", "wrong-path", "bad-request",
    "bad-response", "rejected", "text-code", "wrong-response-identity", "http-error", "network-error",
    "newer-pending", "newer-title-only", "newer-changed-endpoint", "failure-during-json", "unknown-schema", "newer-unknown-schema",
    "unrelated-save-only", "unrelated-draft-only", "different-endpoint-unknown-schema"]) {
    const blocked = await run(adapter.default, { autosave });
    const uncertain = ["no-response", "title-only", "truncated", "merged", "reordered", "missing-identity",
      "wrong-title", "partial-title", "wrong-path", "bad-request", "bad-response", "text-code", "wrong-response-identity",
      "http-error", "network-error", "newer-pending", "newer-title-only", "newer-changed-endpoint", "failure-during-json", "unknown-schema", "newer-unknown-schema", "different-endpoint-unknown-schema"].includes(autosave);
    assert.strictEqual(blocked.result.outcome, uncertain ? "unknown" : "failed", autosave);
    assert.strictEqual(blocked.window.destroyed, false, autosave);
    assert.strictEqual(blocked.window._mmRetainedForInspection, true, autosave);
    assert.ok(!blocked.actions.some(action => ["save", "publish", "reopen"].includes(action)), `${autosave}: 未确认官方全文保存不得离开或提交`);
    for (const secret of ["must-not-appear", "SecretTokenAbc", "BodySecretToken"]) {
      assert.ok(!blocked.result.message.includes(secret), "诊断不输出query/path/body中的token");
    }
  }
  for (const autosave of ["no-slash", "unrelated-save-after-ack", "unrelated-draft-after-ack", "different-endpoint-read-after-ack"]) {
    const confirmed = await run(adapter.default, { autosave });
    assert.strictEqual(confirmed.result.outcome, "draft_saved", autosave);
    assert.strictEqual(confirmed.actions.filter(action => action === "save").length, 1);
  }
  const wrongDraft = await run(adapter.default, { draftUrl: DRAFT.replace("draft-123", "other-draft") });
  assert.strictEqual(wrongDraft.result.outcome, "unknown");
  assert.match(wrongDraft.result.message, /其他草稿/u);
  const newer = await run(adapter.default, { autosave: "newer-success" });
  assert.strictEqual(newer.result.outcome, "draft_saved", "最新全文请求成功后可继续；旧响应不改变latest");
  const formatLoss = await run(adapter.default, { autosave: "format-loss" },
    { data: { title: "文章标题", content: `**开头完整正文**\n\n中间完整正文\n\n结尾完整正文` } });
  assert.strictEqual(formatLoss.result.outcome, "unknown", "全文相同但保存payload格式丢失，不得离开editor");
  assert.ok(!formatLoss.actions.includes("save"));
  for (const content of ["", "文".repeat(20001)]) {
    const rejected = await run(adapter.default, {}, { data: { title: "标题", content } });
    assert.strictEqual(rejected.result.outcome, "failed");
    assert.deepStrictEqual(rejected.actions, ["close"]);
  }

  // 正式 esbuild-loader + production 压缩的注入回调也必须在无模块闭包的 VM 中工作。
  const config = require(path.join(root, ".electron-vue/webpack.main.config.js"));
  const stubDirectory = path.join(directory, "stubs");
  fs.mkdirSync(stubDirectory);
  for (const [name, contents] of Object.entries(stubs)) fs.writeFileSync(path.join(stubDirectory, path.basename(name)), contents);
  const compiled = path.join(directory, "webpack", "adapter.cjs");
  await new Promise((resolve, reject) => {
    const compiler = webpack({ mode: "production", target: config.target, context: root,
      entry: path.join(root, "src/main/services/upLoad/dyArticle.js"),
      output: { path: path.dirname(compiled), filename: path.basename(compiled), library: { type: "commonjs2" } },
      module: config.module, resolve: config.resolve,
      plugins: [new webpack.NormalModuleReplacementPlugin(/^\.\/(?:articleWebTools|publishOutcome|failureScreenshot)\.js$/u, resource => {
        resource.request = path.join(stubDirectory, path.basename(resource.request));
      })],
    });
    compiler.run((error, stats) => compiler.close(() => {
      if (error || stats.hasErrors()) reject(error || new Error(stats.toString({ all: false, errors: true })));
      else resolve();
    }));
  });
  const production = require(compiled);
  assert.strictEqual((await run(production.default, { hintDelay: 4, loadDelay: 6 })).result.outcome, "draft_saved");
  assert.strictEqual((await run(production.default, { mode: "publish" })).result.outcome, "submitted");
  assert.strictEqual((await run(production.default, { persistence: "merged" })).result.outcome, "unknown");
  assert.strictEqual((await run(production.default, { autosave: "truncated" })).result.outcome, "unknown");
  assert.strictEqual((await run(production.default, { autosave: "newer-pending" })).result.outcome, "unknown");
  assert.strictEqual((await run(production.default, { autosave: "failure-during-json" })).result.outcome, "unknown");
  assert.strictEqual((await run(production.default, { autosave: "newer-unknown-schema" })).result.outcome, "unknown");
  assert.strictEqual((await run(production.default, { autosave: "no-slash" })).result.outcome, "draft_saved");
  assert.strictEqual((await run(production.default, { autosave: "unrelated-save-after-ack" })).result.outcome, "draft_saved");
  assert.strictEqual((await run(production.default, { autosave: "newer-changed-endpoint" })).result.outcome, "unknown");
  assert.strictEqual((await run(production.default, { hintDelay: 2, loadDelay: 4 }, summaryData(SUMMARY))).result.outcome, "draft_saved");
  assert.strictEqual((await run(production.default, { mode: "publish" }, summaryData(SUMMARY))).result.outcome, "submitted");
  assert.strictEqual((await run(production.default, { noSummary: true }, summaryData(SUMMARY))).result.outcome, "failed");
  assert.strictEqual((await run(production.default, { autosave: "missing-summary" }, summaryData(SUMMARY))).result.outcome, "unknown");
  assert.strictEqual((await run(production.default, { autosave: "newer-missing-summary" }, summaryData(SUMMARY))).result.outcome, "unknown");
  assert.strictEqual((await run(production.default, { persistence: "wrong-summary" }, summaryData(SUMMARY))).result.outcome, "unknown");
  console.log("test-dy-article-adapter passed (full body and summary autosave receipt; latest request fencing; matching reopened draft identity/content/summary; no retries; production isolated VM)");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  delete globalThis.__dyArticleRender;
  fs.rmSync(directory, { recursive: true, force: true });
});
