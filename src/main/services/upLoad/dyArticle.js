"use strict";

import { pasteArticleHtml, renderUploadedArticle } from "./articleWebTools.js";
import { readPageUrl, replyPublishFailure } from "./publishOutcome.js";
import { capturePublishFailureScreenshot } from "./failureScreenshot.js";
import maybeClosePublishWindow from "./closeWindow.js";
import { canonicalDouyinArticleDraftUrl, isDouyinArticlePageUrl } from "../../publisher-worker/douyin-article-url.js";
export { isDouyinArticlePageUrl } from "../../publisher-worker/douyin-article-url.js";

const TITLE_SELECTOR = 'input[placeholder^="请输入文章标题"],textarea[placeholder^="请输入文章标题"]';
const SUMMARY_SELECTOR = 'input[placeholder^="添加内容摘要或文章精彩部分"],textarea[placeholder^="添加内容摘要或文章精彩部分"]';
// 抖音图文/视频的描述框也是 contenteditable；文章只接受官方 Tiptap 主编辑器。
const BODY_SELECTOR = '#DCPF [class^="editor-"] > .ProseMirror[contenteditable="true"],.editor-DoqDrA > .ProseMirror[contenteditable="true"]';
const TITLE_MARKER = '[data-ebao-dy-article-title="true"]';
const SUMMARY_MARKER = '[data-ebao-dy-article-summary="true"]';
const BODY_MARKER = '[data-ebao-dy-article-body="true"]';
const ACTION_MARKER = '[data-ebao-dy-article-action="true"]';

/** 浏览器注入函数只使用浏览器 globals，兼容正式打包压缩。 */
export function locateDouyinArticleFields(titleSelector, bodySelector, summarySelector = "") {
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 200 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
  };
  const titles = [...document.querySelectorAll(titleSelector)].filter(visible);
  const summaries = summarySelector ? [...document.querySelectorAll(summarySelector)].filter(visible) : [];
  const bodies = [...new Set(document.querySelectorAll(bodySelector))].filter(element => visible(element)
    && element.getBoundingClientRect().height > 60);
  if (titles.length !== 1) return { error: "未找到唯一可见的抖音文章标题输入框" };
  if (bodies.length !== 1) return { error: "未找到唯一可见的抖音文章正文编辑器，可能没有文章权限" };
  if (summaries.length > 1) return { error: "未找到唯一可见的抖音文章摘要输入框" };
  for (const element of document.querySelectorAll("[data-ebao-dy-article-title],[data-ebao-dy-article-body],[data-ebao-dy-article-summary]")) {
    element.removeAttribute("data-ebao-dy-article-title");
    element.removeAttribute("data-ebao-dy-article-body");
    element.removeAttribute("data-ebao-dy-article-summary");
  }
  titles[0].setAttribute("data-ebao-dy-article-title", "true");
  bodies[0].setAttribute("data-ebao-dy-article-body", "true");
  if (summaries[0]) summaries[0].setAttribute("data-ebao-dy-article-summary", "true");
  return { title: String(titles[0].value || ""), body: String(bodies[0].textContent || ""),
    images: bodies[0].querySelectorAll("img").length, maxLength: titles[0].maxLength,
    summaryPresent: summaries.length === 1, summary: String(summaries[0]?.value || ""),
    summaryMaxLength: summaries[0]?.maxLength };
}

/** 同时核对完整正文、段落顺序和 Markdown 结构；前几个字不能充当全文确认。 */
export function readDouyinArticleContent(titleSelector, bodySelector, expectedHtml, savedHtml, summarySelector = "", expectedSummary = "") {
  const title = document.querySelector(titleSelector);
  const summary = summarySelector ? document.querySelector(summarySelector) : null;
  const body = savedHtml === undefined ? document.querySelector(bodySelector)
    : new DOMParser().parseFromString(savedHtml, "text/html").body;
  if (!body || savedHtml === undefined && !title) return { matches: false, readable: false };
  const expected = new DOMParser().parseFromString(expectedHtml, "text/html").body;
  const compact = value => String(value || "").normalize("NFC").replace(/[\s\u200B-\u200D\uFEFF\uFFFC]+/gu, "");
  const blockSelector = "p,h1,h2,h3,h4,h5,h6,li,pre,td,th,blockquote";
  const blocks = root => [...root.querySelectorAll(blockSelector)]
    .filter(element => !element.querySelector(blockSelector))
    .map(element => compact(element.textContent)).filter(Boolean);
  const structure = root => [...root.querySelectorAll("h1,h2,h3,h4,h5,h6,strong,b,em,i,blockquote,ul,ol,li,a,pre,code,table,tr,td,th")]
    .map(element => `${element.tagName.toLowerCase().replace(/^b$/u, "strong").replace(/^i$/u, "em")}:${compact(element.textContent)}${element.tagName.toLowerCase() === "a" ? `:${element.getAttribute("href") || ""}` : ""}`);
  const actualBlocks = blocks(body);
  const expectedBlocks = blocks(expected);
  const actualStructure = structure(body);
  const expectedStructure = structure(expected);
  const text = compact(body.textContent);
  const expectedText = compact(expected.textContent);
  const summaryText = String(summary?.value || "").trim();
  return { readable: true, title: String(title?.value || ""), text,
    summary: summaryText, summaryReadable: savedHtml !== undefined || !expectedSummary || Boolean(summary),
    summaryMatches: savedHtml !== undefined || summaryText === expectedSummary,
    matches: Boolean(expectedText) && text === expectedText
      && JSON.stringify(actualBlocks) === JSON.stringify(expectedBlocks)
      && JSON.stringify(actualStructure) === JSON.stringify(expectedStructure)
      && body.querySelectorAll("img").length === 0 };
}

/** DOM 有字不代表 Tiptap 的 model 已保存；仅旁观官方 autosave，绝不自行发请求或重试。 */
export function observeDouyinArticleDraftSave(page, data, expectedHtml) {
  const expectedTitle = String(data.data?.title || "").trim();
  const expectedSummary = String(data.data?.summary || "").trim();
  const requests = new Map();
  let active = true;
  let sequence = 0;
  let latest = null;
  let differentEndpoint = false;
  const inspect = request => {
    const url = new URL(request.url());
    if (request.method() !== "POST") return;
    if (url.origin !== "https://creator.douyin.com") return;
    if (!/^\/web\/api\/media\/aweme\/draft\/?$/u.test(url.pathname)) {
      let draft;
      try { draft = JSON.parse(request.postData() || "").item?.common?.draft; }
      catch { return; }
      // 图片上传、视频草稿等请求也带 save/draft 路径。仅有关联文章 payload
      // 的未知写入才使旧保存证据失效；变化端点本身绝不能确认成功。
      if (!draft || typeof draft !== "object" || [1, 2, 3, 4].includes(draft.req_type)) return;
      differentEndpoint = true;
      latest = { sequence: ++sequence, mayHaveSaved: true,
        reason: "抖音文章草稿保存接口可能变化，未确认最新完整正文保存" };
      requests.set(request, latest);
      return;
    }
    let draft;
    try { draft = JSON.parse(request.postData() || "").item?.common?.draft; }
    catch {
      latest = { sequence: ++sequence, mayHaveSaved: true, reason: "抖音文章草稿保存请求格式未识别" };
      requests.set(request, latest);
      return;
    }
    // 查询、续编和删除共用此端点；它们不能证明全文保存。
    if ([1, 2, 3, 4].includes(draft?.req_type)) return;
    if (draft?.req_type !== 0) {
      latest = { sequence: ++sequence, mayHaveSaved: true, reason: "抖音文章草稿保存请求格式未识别，未确认最新全文保存" };
      requests.set(request, latest);
      return;
    }
    const record = { sequence: ++sequence, matches: false, confirmed: false, mayHaveSaved: true,
      reason: "抖音文章完整正文草稿保存请求仍未返回" };
    latest = record;
    requests.set(request, record);
    const title = String(draft.title || "").trim();
    const body = typeof draft.long_article === "string" ? draft.long_article : "";
    record.draftUrl = canonicalDouyinArticleDraftUrl(
      `https://creator.douyin.com/creator-micro/content/post/article?enter_from=draft&creation_id=${encodeURIComponent(String(draft.creation_id || ""))}&init_timestamp=${encodeURIComponent(String(draft.init_timestamp || ""))}`);
    if (title !== expectedTitle) {
      record.reason = "抖音文章草稿保存请求标题与当前文章不一致";
      return;
    }
    // 官方文章摘要保存/回填字段是 description；封面建议接口的 summary 不是草稿摘要。
    if (draft.description !== undefined && typeof draft.description !== "string") {
      record.reason = "抖音文章草稿保存请求中的摘要格式未识别";
      return;
    }
    if (String(draft.description || "").trim() !== expectedSummary) {
      record.reason = "抖音文章草稿保存请求中的摘要与待发布摘要不一致";
      return;
    }
    if (!body.trim()) {
      record.reason = "仅观察到抖音文章标题保存，未确认完整正文保存";
      return;
    }
    if (!record.draftUrl) {
      record.reason = "抖音文章草稿保存请求身份未确认";
      return;
    }
    record.match = (async () => {
      try {
        const html = renderUploadedArticle({ ...data, data: { ...data.data, content: body } }, {});
        const snapshot = await page.evaluate(readDouyinArticleContent, TITLE_MARKER, BODY_MARKER, expectedHtml, html);
        record.matches = active && snapshot.readable && snapshot.matches;
        if (!record.matches) record.reason = "抖音文章保存请求中的正文或段落与待发布全文不一致";
      } catch { record.reason = "抖音文章保存请求中的正文格式未识别"; }
    })();
  };
  const onRequest = request => {
    if (!active) return;
    try { inspect(request); } catch { /* 诊断不泄露请求体或账号信息。 */ }
  };
  const onRequestFailed = request => {
    const record = requests.get(request);
    if (active && record) {
      record.failed = true;
      record.confirmed = false;
      record.reason = "抖音文章完整正文草稿保存网络请求失败";
    }
  };
  const onResponse = async response => {
    let record;
    try {
      record = requests.get(response.request());
      // 仅接受监听启动后亲自看到的请求，旧任务晚到的响应不能确认本次草稿。
      if (!active || !record) return;
      await record.match;
      if (!active || record.failed) return;
      const status = response.status?.();
      if (!Number.isSafeInteger(status) || status < 200 || status >= 300) {
        record.reason = `抖音文章草稿保存接口返回${Number.isSafeInteger(status) ? ` HTTP ${status}` : "未识别的 HTTP 状态"}`;
        return;
      }
      const result = await response.json();
      if (!active || record.failed) return;
      if (result?.status_code !== 0) {
        if (Number.isSafeInteger(result?.status_code)) record.mayHaveSaved = false;
        record.reason = Number.isSafeInteger(result?.status_code)
          ? `抖音文章完整正文草稿保存被拒绝（错误码 ${result.status_code}）`
          : "抖音文章完整正文草稿保存响应格式未识别";
        return;
      }
      if (!record.matches) return;
      if (result.draft) {
        const responseUrl = canonicalDouyinArticleDraftUrl(
          `https://creator.douyin.com/creator-micro/content/post/article?enter_from=draft&creation_id=${encodeURIComponent(String(result.draft.creation_id || ""))}&init_timestamp=${encodeURIComponent(String(result.draft.init_timestamp || ""))}`);
        if (responseUrl !== record.draftUrl) {
          record.reason = "抖音文章草稿保存回执身份与当前文章不一致";
          return;
        }
        if (result.draft.description !== undefined && (typeof result.draft.description !== "string"
          || result.draft.description.trim() !== expectedSummary)) {
          record.reason = "抖音文章草稿保存回执中的摘要与待发布摘要不一致";
          return;
        }
      }
      record.confirmed = true;
    } catch { if (active && record) record.reason = "抖音文章完整正文草稿保存响应未能读取"; }
  };
  page.on("request", onRequest);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);
  return {
    mayHaveSaved: () => [...requests.values()].some(record => record.mayHaveSaved),
    async waitForSave() {
      for (let attempt = 0; attempt < 60; attempt++) {
        // 新的保存请求一旦出现，较早响应即便成功也不代表平台当前正文。
        if (latest?.confirmed) return { confirmed: true, draftUrl: latest.draftUrl };
        await page.waitForTimeout(500);
      }
      return { confirmed: false, reason: latest?.reason || (differentEndpoint
        ? "抖音文章草稿保存接口可能变化，未确认完整正文保存"
        : "未观察到抖音文章完整正文草稿保存请求") };
    },
    stop() {
      active = false;
      page.off("request", onRequest);
      page.off("requestfailed", onRequestFailed);
      page.off("response", onResponse);
      requests.clear();
    },
  };
}

/** 不接受封面「保存成功」、旧稿列表标题或地址变化作为文章提交回执。 */
export function readDouyinArticleReceipt() {
  const notices = [...document.querySelectorAll('[role="alert"],[role="status"],.semi-toast,.semi-notification')]
    .filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).map(element => String(element.innerText || element.textContent || "").trim());
  const failed = notices.find(text => /发布失败|保存草稿失败|请完成验证|请先登录|正文超出|标题超出|正文内容不能少于\s*100\s*字/u.test(text));
  if (failed) return { state: "failed", message: failed.slice(0, 180) };
  if (notices.some(text => /^(?:发布成功|文章发布成功)[！!。\s]*$/u.test(text))) return { state: "success" };
  return { state: "pending" };
}

export function markDouyinArticleAction(labels, marker, articleHint = false) {
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
  };
  const candidates = [...document.querySelectorAll(articleHint
    ? '[class*="hint-text"][class*="continue"]' : 'button,[role="button"]')]
    .filter(element => visible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true"
      && !element.closest('.semi-modal,[role="dialog"]')
      && labels.includes(String(element.textContent || "").trim())
      && (!articleHint || /上次未发布的文章/u.test(String(element.closest('[class*="form-hint"]')?.textContent || ""))));
  if (candidates.length !== 1) return false;
  for (const element of document.querySelectorAll(`[${marker}]`)) element.removeAttribute(marker);
  candidates[0].setAttribute(marker, "true");
  return true;
}

async function waitForUniqueAction(page, labels, marker, articleHint = false) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await page.evaluate(markDouyinArticleAction, labels, marker, articleHint)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function locateFields(page, summary = "") {
  await page.waitForSelector(TITLE_SELECTOR, { visible: true, timeout: 25000 });
  await page.waitForSelector(BODY_SELECTOR, { visible: true, timeout: 25000 });
  if (summary) {
    try { await page.waitForSelector(SUMMARY_SELECTOR, { visible: true, timeout: 25000 }); }
    catch { throw new Error("抖音文章摘要输入框不可用，已停止提交"); }
  }
  const fields = await page.evaluate(locateDouyinArticleFields, TITLE_SELECTOR, BODY_SELECTOR, SUMMARY_SELECTOR);
  if (fields.error) throw new Error(fields.error);
  if (summary && !fields.summaryPresent) throw new Error("抖音文章摘要输入框不可用，已停止提交");
  return fields;
}

async function verifyContent(page, title, html, summary = "", waitForLoadedDraft = false) {
  let snapshot;
  for (let attempt = 0; attempt < (waitForLoadedDraft ? 60 : 1); attempt++) {
    await locateFields(page, summary);
    snapshot = await page.evaluate(readDouyinArticleContent, TITLE_MARKER, BODY_MARKER, html, undefined, SUMMARY_MARKER, summary);
    if (snapshot.readable && snapshot.title.trim() === title && snapshot.matches && snapshot.summaryReadable && snapshot.summaryMatches) return;
    if (waitForLoadedDraft) await page.waitForTimeout(500);
  }
  if (!snapshot.readable) throw new Error("抖音文章标题或正文不可读取，已停止提交");
  if (snapshot.title.trim() !== title) throw new Error("抖音文章标题未完整写入，已停止提交");
  if (!snapshot.matches) throw new Error("抖音文章正文或段落未完整写入，已停止提交");
  if (!snapshot.summaryReadable) throw new Error("抖音文章摘要不可读取，已停止提交");
  if (!snapshot.summaryMatches) throw new Error("抖音文章摘要未完整写入或保存，已停止提交");
}

async function waitForPage(page, draftEditor = false) {
  await page.waitForFunction(wantsDraft => {
    const url = new URL(location.href);
    if (url.origin !== "https://creator.douyin.com") return false;
    if (!wantsDraft) return url.pathname === "/creator-micro/content/upload" && url.searchParams.get("default-tab") === "5";
    return url.pathname === "/creator-micro/content/post/article"
      && ["draft", "home_draft"].includes(url.searchParams.get("enter_from"))
      && Boolean(url.searchParams.get("creation_id")) && Boolean(url.searchParams.get("init_timestamp"));
  }, { timeout: 30000 }, draftEditor);
}

async function retainAndReport(page, data, window, event, message, outcome = "unknown") {
  const shot = await capturePublishFailureScreenshot(page, data);
  if (window && !window.isDestroyed()) {
    window._mmRetainedForInspection = true;
    try { window.show(); window.focus(); } catch { /* 回执仍可交付。 */ }
  }
  event.reply("puppeteerFile-done", { ...data, status: outcome !== "failed", outcome,
    needsAttention: true, publishAbnormal: outcome === "unknown", message,
    ...(shot ? { failScreenshot: shot } : {}) });
}

/** 官方文章入口 → Tiptap → 单次提交。草稿必须重新打开并核对全文才算成功。 */
export default async function publishDouyinArticle(page, data, window, event) {
  const draft = data.publishToDraft === true;
  let touched = false;
  let submitted = false;
  let replied = false;
  let saveObserver;
  const resultEvent = { reply(channel, payload) {
    if (replied) return;
    replied = true;
    try { event.reply(channel, payload); }
    catch { console.warn("抖音文章结果回执发送失败，不会重新提交"); }
  } };
  try {
    const title = String(data.data?.title || "").trim();
    const content = String(data.data?.content || "");
    const summary = String(data.data?.summary || "").trim();
    if (!title || title.length > 30) throw new Error("抖音文章标题须为 1 至 30 字");
    if (summary.length > 30) throw new Error("抖音文章摘要不能超过 30 字");
    if (!content.trim() || content.length > 20000) throw new Error("抖音文章正文（含内容声明）须为 1 至 20000 字");
    if (!isDouyinArticlePageUrl(readPageUrl(page))) throw new Error("当前不是抖音文章入口，已停止提交");
    if (new URL(readPageUrl(page)).pathname === "/creator-micro/content/upload") {
      const entry = await waitForUniqueAction(page, ["我要发文"], "data-ebao-dy-article-entry");
      if (!entry) throw new Error("未找到唯一的抖音「我要发文」入口，可能没有文章权限");
      await page.click('[data-ebao-dy-article-entry="true"]');
      await page.waitForFunction(() => location.origin === "https://creator.douyin.com"
        && location.pathname === "/creator-micro/content/post/article", { timeout: 25000 });
    }
    let initial = await locateFields(page, summary);
    if (initial.title.trim() || initial.body.trim() || initial.images || initial.summary.trim()) {
      throw new Error("抖音文章编辑器已有内容，已停止以免覆盖原稿");
    }
    if (initial.maxLength > 0 && title.length > initial.maxLength) throw new Error("抖音文章标题超过页面限制，已停止提交");
    if (initial.summaryMaxLength > 0 && summary.length > initial.summaryMaxLength) throw new Error("抖音文章摘要超过页面限制，已停止提交");
    if (await page.evaluate(readDouyinArticleReceipt).then(result => result.state !== "pending")) {
      throw new Error("抖音文章页面已有提交提示，无法区分本次回执，已停止提交");
    }
    const html = renderUploadedArticle(data, {});
    saveObserver = observeDouyinArticleDraftSave(page, data, html);
    // 官方每 500ms 建立一次 autosave 基线。首次有 draft 对象时只记基线，
    // 直接「暂存离开」会返回成功但没有任何服务端写入。先让空白基线建立；
    // 后续仍必须观察完整正文保存的成功回执，此等待绝不能充当保存确认。
    await page.waitForTimeout(1100);
    initial = await locateFields(page, summary);
    if (initial.title.trim() || initial.body.trim() || initial.images || initial.summary.trim()) {
      throw new Error("抖音文章编辑器已有内容，已停止以免覆盖原稿");
    }
    touched = true; // 文章页面会自动保存；任何后续不确定状态必须留窗供核对。
    await page.click(TITLE_MARKER, { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await locateFields(page, summary);
    await page.click(TITLE_MARKER);
    await page.keyboard.sendCharacter(title);
    if (summary) {
      await page.click(SUMMARY_MARKER, { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.keyboard.sendCharacter(summary);
    }
    await pasteArticleHtml(page, BODY_MARKER, html, content, page, [], {
      verifyWholeBody: true,
    });
    await verifyContent(page, title, html, summary);
    await page.click(TITLE_MARKER); // 将正文更改交给编辑器保存。
    const saved = await saveObserver.waitForSave();
    if (!saved.confirmed) throw new Error(saved.reason + "；已保留文章编辑页，不会自动重试");
    const action = await page.evaluate(markDouyinArticleAction,
      draft ? ["暂存离开"] : ["发布"], "data-ebao-dy-article-action");
    if (!action) throw new Error("未找到唯一可用的抖音文章" + (draft ? "暂存离开" : "发布") + "按钮，已停止提交");
    await verifyContent(page, title, html, summary);
    if (await page.evaluate(readDouyinArticleReceipt).then(result => result.state !== "pending")) {
      throw new Error("抖音文章页面已有提交提示，已停止提交");
    }
    const latestSave = await saveObserver.waitForSave();
    if (!latestSave.confirmed || latestSave.draftUrl !== saved.draftUrl) {
      throw new Error("抖音文章最新完整正文草稿保存或身份未确认，已保留编辑页");
    }
    saveObserver.stop();
    submitted = true;
    await page.click(ACTION_MARKER);
    if (draft) {
      // 官方「暂存离开」成功后回到 tab=5；再从服务端草稿提示进入，不能把跳转当作保存成功。
      await waitForPage(page);
      const continued = await waitForUniqueAction(page, ["继续编辑"], "data-ebao-dy-article-continue", true);
      if (!continued) throw new Error("抖音文章草稿未出现唯一的继续编辑入口，请到后台核对；不会自动重试");
      await page.click('[data-ebao-dy-article-continue="true"]');
      await waitForPage(page, true);
      const draftUrl = canonicalDouyinArticleDraftUrl(readPageUrl(page));
      if (!draftUrl) throw new Error("抖音文章草稿身份未确认，请到后台核对；不会自动重试");
      if (draftUrl !== saved.draftUrl) throw new Error("抖音文章继续编辑入口指向其他草稿，请到后台核对；不会自动重试");
      await verifyContent(page, title, html, summary, true);
      if (data.manualArticleAssets === true && window && !window.isDestroyed()) {
        window._mmRetainedForInspection = true;
        try { window.show(); window.focus(); } catch { /* 草稿回执仍可交付。 */ }
      }
      resultEvent.reply("puppeteerFile-done", { ...data, status: true, outcome: "draft_saved", draftUrl,
        publishPageUrl: readPageUrl(page), message: "抖音文章草稿已重新打开并核对全文和摘要" });
      if (!data.manualArticleAssets) maybeClosePublishWindow({ ...data, closeWindowAfterPublish: true }, window);
      return;
    }
    let receipt = { state: "pending" };
    for (let attempt = 0; attempt < 60; attempt++) {
      receipt = await page.evaluate(readDouyinArticleReceipt);
      if (receipt.state !== "pending") break;
      await page.waitForTimeout(500);
    }
    if (receipt.state === "failed") {
      await retainAndReport(page, data, window, resultEvent, `抖音文章${receipt.message}；不会自动重试`, "failed");
      return;
    }
    if (receipt.state !== "success") throw new Error("抖音文章发布结果未确认，请到后台核对；不会自动重试");
    resultEvent.reply("puppeteerFile-done", { ...data, status: true, outcome: "submitted",
      publishPageUrl: readPageUrl(page), message: "抖音确认文章提交成功" });
    maybeClosePublishWindow({ ...data, closeWindowAfterPublish: true }, window);
  } catch (error) {
    const message = error?.message || String(error);
    if (touched || submitted) await retainAndReport(page, data, window, resultEvent, message,
      submitted || saveObserver?.mayHaveSaved() ? "unknown" : "failed");
    else await replyPublishFailure({ page, data, window, event: resultEvent, message, closeWindow: true });
  } finally {
    saveObserver?.stop();
  }
}
