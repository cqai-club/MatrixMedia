"use strict";

import { replyPublishFailure, replyPublishOutcome, readPageUrl } from "./publishOutcome.js";
import { renderArticleHtml } from "../../publisher-worker/article-content.js";

const EDITOR_SELECTOR = ".ProseMirror,.ql-editor,[contenteditable='true']";
const TITLE_SELECTOR = "input[placeholder*='标题'],textarea[placeholder*='标题']";

export async function findArticleEditor(page) {
  await page.waitForSelector(TITLE_SELECTOR, { visible: true, timeout: 25000 });
  const editor = await page.evaluate(selector => {
    const candidates = [...document.querySelectorAll(selector)];
    const target = candidates.find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 250 && rect.height > 60 && getComputedStyle(element).visibility !== "hidden";
    });
    if (!target) return "";
    target.setAttribute("data-ebao-article-editor", "true");
    return "[data-ebao-article-editor='true']";
  }, EDITOR_SELECTOR);
  if (!editor) throw new Error("文章编辑器不可用，可能没有发文权限");
  return editor;
}

/** Baijiahao has used both a top-level editor and an UEditor iframe. */
export async function findBaijiahaoEditor(page) {
  try { return { context: page, selector: await findArticleEditor(page) }; }
  catch (error) {
    const frame = page.frames().find(candidate => candidate.name() === "ueditor_0" || /ueditor/i.test(candidate.url()));
    if (!frame) throw error;
    await frame.waitForSelector("body[contenteditable='true']", { visible: true, timeout: 10000 });
    return { context: frame, selector: "body[contenteditable='true']" };
  }
}

export async function fillArticleTitle(page, title, { stableVisible = false } = {}) {
  await page.waitForSelector(TITLE_SELECTOR, { visible: true, timeout: 25000 });
  if (!stableVisible) {
    await page.click(TITLE_SELECTOR, { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type(TITLE_SELECTOR, title, { delay: 25 });
    const actual = await page.$eval(TITLE_SELECTOR, element => element.value || "");
    if (actual.trim() !== title.trim()) throw new Error("文章标题未写入");
    return TITLE_SELECTOR;
  }
  const selector = await page.evaluate(candidateSelector => {
    const candidates = [...document.querySelectorAll(candidateSelector)].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 200 && rect.height > 0
        && getComputedStyle(element).visibility !== "hidden";
    });
    if (candidates.length !== 1) return "";
    for (const element of document.querySelectorAll("[data-ebao-article-title]")) {
      element.removeAttribute("data-ebao-article-title");
    }
    candidates[0].setAttribute("data-ebao-article-title", "true");
    return "[data-ebao-article-title='true']";
  }, TITLE_SELECTOR);
  if (!selector) throw new Error("文章标题输入框未能唯一定位");
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(selector, title, { delay: 25 });
  try {
    await page.waitForFunction((candidateSelector, expected) => {
      const candidates = [...document.querySelectorAll(candidateSelector)].filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 200 && rect.height > 0
          && getComputedStyle(element).visibility !== "hidden";
      });
      if (candidates.length !== 1 || String(candidates[0].value || "").trim() !== expected) return false;
      // React may replace the input while page.type is still completing.
      candidates[0].setAttribute("data-ebao-article-title", "true");
      return true;
    }, { timeout: 5000 }, TITLE_SELECTOR, title.trim());
  } catch { throw new Error("文章标题未写入"); }
  return selector;
}

export async function pasteArticleHtml(page, editor, html, plain, context = page, expectedImages = [], options = {}) {
  const probe = plain.split(/\r?\n/u)
    .map(line => line.replace(/!\[[^\]]*\]\([^)]*\)/gu, "").replace(/^\s*(?:#+|>)\s*/u, "").trim())
    .find(Boolean)?.slice(0, 16) || "";
  if (!probe) throw new Error("文章正文没有可验证的文本");
  const expectedText = options.verifyWholeBody ? compactArticleText(html) : "";
  if (options.verifyWholeBody && !expectedText) throw new Error("文章正文没有可验证的文本");
  await context.click(editor);
  const before = await context.evaluate(selector => document.querySelector(selector)?.innerHTML || "", editor);
  const written = async () => {
    try {
      await context.waitForFunction((selector, expected, images, wholeBody) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        const text = String(element.textContent || "");
        if (wholeBody) {
          if (!text.normalize("NFC").replace(/[\s\u200B-\u200D\uFEFF\uFFFC]+/gu, "").includes(wholeBody)) return false;
        } else if (!text.includes(expected)) return false;
        const actualImages = [...element.querySelectorAll("img")].map(img => img.getAttribute("src"));
        return images.every(url => actualImages.includes(url));
      }, { timeout: 1800 }, editor, probe, expectedImages, expectedText);
      return true;
    } catch { return false; }
  };
  const unchanged = () => context.evaluate((selector, original) =>
    (document.querySelector(selector)?.innerHTML || "") === original, editor, before);
  const plainArticle = expectedImages.length === 0
    && !/<(?:h[1-6]|blockquote|strong|em|ul|ol|li|a|pre|code|table|img)\b/iu.test(html);

  // Toutiao's ProseMirror can display a synthetic paste in the DOM while its
  // document model (and the site's word counter/save payload) stays empty.
  // CDP keyboard insertion takes the editor's actual input path instead.
  if (options.preferKeyboardForPlain && plainArticle) {
    await page.keyboard.sendCharacter(plain);
    if (await written()) return;
    if (!await unchanged()) throw new Error("文章正文未完整写入");
  }

  // Worker windows are hidden: macOS Cmd+V depends on a focused native window
  // and can leave the editor empty. Deliver HTML to the editor's paste handler.
  await context.evaluate((selector, rich, text) => {
    const element = document.querySelector(selector);
    if (!element) return;
    element.focus();
    try {
      const data = new DataTransfer();
      data.setData("text/html", rich);
      data.setData("text/plain", text);
      element.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true, cancelable: true, clipboardData: data,
      }));
    } catch { /* The next contenteditable strategy may still work. */ }
  }, editor, html, plain);
  if (await written()) return;
  if (!await unchanged()) throw new Error("文章正文未完整写入");

  // Contenteditable editors that ignore synthetic paste may still accept the
  // browser's insertHTML command, which preserves headings and inline images.
  await context.evaluate((selector, rich) => {
    const element = document.querySelector(selector);
    if (element) {
      element.focus();
      try { document.execCommand("insertHTML", false, rich); }
      catch { /* CDP text insertion remains available for plain articles. */ }
    }
  }, editor, html);
  if (await written()) return;
  if (!await unchanged()) throw new Error("文章正文未完整写入");

  // CDP text insertion needs no OS clipboard. Only use it for unformatted
  // articles, never silently strip Markdown formatting or uploaded images.
  if (plainArticle && !options.preferKeyboardForPlain) {
    await context.click(editor);
    await page.keyboard.sendCharacter(plain);
    if (await written()) return;
  }
  throw new Error("文章正文未写入");
}

function compactArticleText(html) {
  return String(html || "").replace(/<[^>]*>/gu, "")
    .replace(/&(?:#(x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/giu, entity => {
      const named = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " };
      if (entity[1] !== "#") return named[entity.toLowerCase()] || entity;
      const numeric = entity.slice(2, -1);
      const code = numeric[0]?.toLowerCase() === "x"
        ? Number.parseInt(numeric.slice(1), 16) : Number.parseInt(numeric, 10);
      return Number.isSafeInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    })
    .normalize("NFC").replace(/[\s\u200B-\u200D\uFEFF\uFFFC]+/gu, "");
}

/** A visible DOM string is not proof that Toutiao's editor accepted content. */
export async function confirmToutiaoBodyAccepted(page, timeout = 7000) {
  const readCount = () => {
    const values = [...document.querySelectorAll("span,div,p,label")]
      .filter(element => !element.closest("[contenteditable='true']")
        && element.getBoundingClientRect().width > 0)
      .map(element => /^共\s*(\d+)\s*字$/u.exec(String(element.textContent || "").trim())?.[1])
      .filter(value => value !== undefined)
      .map(Number);
    return values.length ? Math.max(...values) : null;
  };
  try {
    await page.waitForFunction(readCount, { timeout });
  } catch { /* Report the current indicator value below. */ }
  const count = await page.evaluate(readCount);
  if (count > 0) return;
  throw new Error(count === 0
    ? "头条正文未进入平台编辑器（字数仍为 0），未确认草稿保存"
    : "头条正文未获得平台字数确认，未确认草稿保存");
}

function emptyToutiaoContent(content) {
  return !String(content || "").replace(/<[^>]*>/gu, "")
    .replace(/&(?:nbsp|#160|#xA0);/giu, " ").trim();
}

async function readToutiaoDraftSaveMarker(page) {
  if (typeof page.evaluate !== "function") return "";
  try {
    return await page.evaluate(() => {
      const labels = [...document.querySelectorAll("span,div,p")]
        .filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0
            && ![...element.children].some(child =>
              String(child.textContent || "").trim() === String(element.textContent || "").trim());
        })
        .map(element => String(element.textContent || "").trim());
      if (labels.some(label => /^草稿保存中/u.test(label))) return "saving";
      if (labels.some(label => /^(?:草稿已保存|草稿保存成功|已自动保存|自动保存成功)$/u.test(label))) return "saved";
      if (labels.some(label => /^(?:草稿保存失败|保存草稿失败)$/u.test(label))) return "failed";
      return "";
    });
  } catch { return ""; }
}

/** Observe title-only and full-body saves separately; only the latter confirms content. */
export function observeToutiaoDraftSave(page) {
  let expectedTitle = "";
  let expectedBodyText = "";
  const initial = { requests: new Set(), responses: 0, failures: 0, lastCode: undefined,
    httpStatus: undefined, invalidResponse: false, saved: false };
  const full = { requests: new Set(), responses: 0, failures: 0, lastCode: undefined,
    httpStatus: undefined, invalidResponse: false, saved: false };
  let changedPath = false;
  let changedPayload = false;
  let partialBody = false;
  let finalBodyExpected = false;
  const diagnostic = {
    relatedPosts: new Set(), saveEndpointPosts: new Set(), alternateOrigin: false,
    alternatePath: false, missingTitle: false, missingContent: false, titleMismatch: false,
    titleOnly: false, unreadablePayload: false, saveMarker: "",
  };
  const inspect = request => {
    const url = new URL(request.url());
    if (request.method() !== "POST") return null;
    const path = url.pathname;
    const relatedPath = /(?:article|draft|publish|save)/iu.test(path);
    const relatedHost = url.hostname === "toutiao.com" || url.hostname.endsWith(".toutiao.com");
    if (finalBodyExpected && relatedHost && relatedPath) {
      diagnostic.relatedPosts.add(request);
      if (url.origin !== "https://mp.toutiao.com") diagnostic.alternateOrigin = true;
      else if (path === "/mp/agw/article/publish") diagnostic.saveEndpointPosts.add(request);
      else diagnostic.alternatePath = true;
    }
    if (url.origin !== "https://mp.toutiao.com" || !relatedPath) return null;
    const raw = request.postData() || "";
    let fields = new URLSearchParams(raw);
    if (raw.trimStart().startsWith("{")) {
      let payload;
      try { payload = JSON.parse(raw); }
      catch {
        if (finalBodyExpected) diagnostic.unreadablePayload = true;
        return null;
      }
      fields = { get: key => payload?.[key] };
    }
    const requestTitle = String(fields.get("title") || "").trim();
    if (!expectedTitle || requestTitle !== expectedTitle) {
      if (path === "/mp/agw/article/publish" && expectedTitle && !requestTitle) {
        changedPayload = true;
        if (finalBodyExpected) diagnostic.missingTitle = true;
      } else if (finalBodyExpected && path === "/mp/agw/article/publish" && requestTitle) {
        diagnostic.titleMismatch = true;
      }
      return null;
    }
    const contentField = fields.get("content");
    if (finalBodyExpected && path === "/mp/agw/article/publish"
      && (contentField === undefined || contentField === null)) diagnostic.missingContent = true;
    const content = String(contentField || "");
    const titleOnly = emptyToutiaoContent(content);
    if (titleOnly && finalBodyExpected) diagnostic.titleOnly = true;
    const fullBody = Boolean(expectedBodyText
      && compactArticleText(content).includes(expectedBodyText));
    if (!titleOnly && expectedBodyText && !fullBody) partialBody = true;
    if (!titleOnly && !fullBody) return null;
    if (path !== "/mp/agw/article/publish") {
      changedPath = true;
      return null;
    }
    return { stage: titleOnly ? initial : full, fields, fullBody };
  };
  const onRequest = request => {
    try {
      const match = inspect(request);
      if (match) match.stage.requests.add(request);
    } catch { /* The site's request format may change; do not expose its body. */ }
  };
  const onRequestFailed = request => {
    try {
      const match = inspect(request);
      if (!match) return;
      match.stage.requests.add(request);
      match.stage.failures++;
    } catch { /* A failed navigation can dispose its request. */ }
  };
  const onResponse = async response => {
    try {
      const request = response.request();
      const match = inspect(request);
      if (!match) return;
      const { stage } = match;
      stage.requests.add(request);
      stage.responses++;
      const httpStatus = response.status?.();
      if (Number.isSafeInteger(httpStatus) && httpStatus >= 400) {
        stage.httpStatus = httpStatus;
        return;
      }
      let result;
      try { result = await response.json(); }
      catch {
        stage.invalidResponse = true;
        return;
      }
      const code = typeof result?.code === "string" && /^\d+$/u.test(result.code)
        ? Number(result.code) : result?.code;
      if (!Number.isSafeInteger(code)) {
        stage.invalidResponse = true;
        return;
      }
      stage.lastCode = code;
      // A visible editor may create its first draft with the full body and no
      // pgc_id. The platform's business response and draft-list check remain required.
      stage.saved = code === 0;
    } catch { /* Navigation can dispose a response before its body is available. */ }
  };
  page.on("request", onRequest);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);
  return {
    expect(title, body, renderedHtml) {
      expectedTitle = String(title || "").trim();
      // The adapter supplies its final rendered HTML after image uploads. The
      // Markdown fallback keeps existing callers and title-only saves working.
      let html = renderedHtml;
      if (html === undefined) {
        try { html = renderArticleHtml({ body: String(body || ""), assets: [] }, {}); }
        catch { html = ""; } // Managed images require the later rendered HTML.
      } else {
        // A save observed during title editing or image upload cannot prove
        // that the final rendered body was persisted after this point.
        full.requests.clear();
        full.responses = 0;
        full.failures = 0;
        full.lastCode = undefined;
        full.httpStatus = undefined;
        full.invalidResponse = false;
        full.saved = false;
        partialBody = false;
        finalBodyExpected = true;
        diagnostic.relatedPosts.clear();
        diagnostic.saveEndpointPosts.clear();
        diagnostic.alternateOrigin = false;
        diagnostic.alternatePath = false;
        diagnostic.missingTitle = false;
        diagnostic.missingContent = false;
        diagnostic.titleMismatch = false;
        diagnostic.titleOnly = false;
        diagnostic.unreadablePayload = false;
        diagnostic.saveMarker = "";
      }
      expectedBodyText = compactArticleText(html);
    },
    async waitForInitialTitleSave(timeout = 30000) {
      const deadline = Date.now() + timeout;
      while (!initial.saved && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (initial.saved) return { confirmed: true };
      return { confirmed: false, reason: initial.lastCode !== undefined && initial.lastCode !== 0
        ? `头条初始草稿保存接口拒绝（错误码 ${initial.lastCode}）`
        : initial.httpStatus !== undefined ? `头条初始草稿保存接口返回 HTTP ${initial.httpStatus}`
          : initial.invalidResponse ? "头条初始草稿保存响应格式未识别"
            : initial.failures > 0 ? "头条初始草稿保存网络请求失败"
              : initial.responses > 0 ? "头条初始草稿保存响应未确认"
                : initial.requests.size > 0 ? "头条初始草稿保存请求仍未返回"
                  : changedPath ? "头条保存接口路径变化，未识别保存请求"
                    : changedPayload ? "头条初始草稿保存请求体格式未识别"
                      : "未观察到头条仅标题的初始草稿保存请求" };
    },
    async waitForFullBodySave(timeout = 30000) {
      const deadline = Date.now() + timeout;
      while (!full.saved && Date.now() < deadline) {
        diagnostic.saveMarker = await readToutiaoDraftSaveMarker(page);
        if (!full.saved) await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (full.saved) return { confirmed: true };
      let reason = "未观察到头条完整正文的草稿保存请求";
      if (full.lastCode !== undefined && full.lastCode !== 0) {
        reason = `头条完整正文草稿保存接口拒绝（错误码 ${full.lastCode}）`;
      } else if (full.httpStatus !== undefined) {
        reason = `头条完整正文草稿保存接口返回 HTTP ${full.httpStatus}`;
      } else if (full.invalidResponse) reason = "头条完整正文草稿保存响应格式未识别";
      else if (full.failures > 0) reason = "头条完整正文草稿保存网络请求失败";
      else if (full.responses > 0) reason = "头条完整正文草稿保存响应未确认";
      else if (full.requests.size > 0) reason = "头条完整正文草稿保存请求仍未返回";
      else if (partialBody) reason = "头条保存请求中的正文不完整或与待发布正文不一致";
      else if (diagnostic.alternatePath) reason = "头条可能更换了草稿保存接口路径，未确认完整正文保存";
      else if (diagnostic.alternateOrigin) reason = "头条可能更换了草稿保存接口域名，未确认完整正文保存";
      else if (diagnostic.unreadablePayload || diagnostic.missingTitle || diagnostic.missingContent) {
        reason = "头条草稿保存请求体格式未识别，未确认完整正文保存";
      } else if (diagnostic.titleMismatch) reason = "头条草稿保存请求的标题与当前文章不一致";
      else if (diagnostic.titleOnly) reason = "仅观察到头条标题草稿保存，未观察到完整正文保存";
      else if (diagnostic.saveEndpointPosts.size > 0) reason = "观察到头条文章保存接口，但未确认完整正文保存";
      else if (diagnostic.relatedPosts.size > 0) reason = "观察到头条相关请求，但未确认完整正文保存";
      // The page indicator may refer to an earlier title-only save. Describe
      // it for diagnosis, but never use it alone to leave the editor.
      const marker = diagnostic.saveMarker === "saving" ? "；页面仍显示草稿保存中"
        : diagnostic.saveMarker === "saved" ? "；页面显示已保存，但无法确认完整正文"
          : diagnostic.saveMarker === "failed" ? "；页面显示草稿保存失败" : "";
      return { confirmed: false, reason: reason + marker };
    },
    stop: () => {
      page.off("request", onRequest);
      page.off("requestfailed", onRequestFailed);
      page.off("response", onResponse);
      initial.requests.clear();
      full.requests.clear();
      diagnostic.relatedPosts.clear();
      diagnostic.saveEndpointPosts.clear();
    },
  };
}

/** Legacy title-only confirmation; the Toutiao adapter no longer waits for it. */
export async function confirmToutiaoInitialDraftAutosave(page, title, saveObserver, timeout = 30000) {
  const saved = await saveObserver.waitForInitialTitleSave(timeout);
  if (!saved.confirmed) return saved;
  try {
    const marker = await page.waitForFunction((expected, selector) => {
      if (String(document.querySelector(selector)?.value || "").trim() !== expected) return false;
      return [...document.querySelectorAll("span,div,p")].some(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          && /^(?:草稿已保存|草稿保存成功|已自动保存|自动保存成功)$/u.test(String(element.textContent || "").trim());
      });
    }, { timeout: 10000 }, String(title || "").trim(), TITLE_SELECTOR);
    await marker.dispose();
    return { confirmed: true };
  } catch { return { confirmed: false, reason: "头条初始草稿尚未在页面确认，未继续填写正文" }; }
}

/** Toutiao autosaves; a stale failure toast can coexist with a newer save. */
export async function confirmToutiaoDraftAutosave(page, title, timeout = 30000, saveObserver,
  { expectedHtml, coverUrl } = {}) {
  const saved = await saveObserver.waitForFullBodySave(timeout);
  if (!saved.confirmed) return saved;
  try {
    await page.goto("https://mp.toutiao.com/profile_v4/manage/draft", {
      waitUntil: "domcontentloaded", timeout: 15000,
    });
    await page.waitForFunction(expected => [...document.querySelectorAll("a,span,p,div,h1,h2,h3,h4")]
      .filter(element => element.getBoundingClientRect().width > 0
        && String(element.textContent || "").trim() === expected
        && ![...element.children].some(child => String(child.textContent || "").trim() === expected)).length === 1,
    { timeout: 15000 }, title);
  } catch { return { confirmed: false, reason: "头条草稿箱未确认这篇文章" }; }

  // Existing callers only need the exact-title list check. Toutiao's cover
  // picker can save after the body, so callers with final expectations reopen
  // the draft and verify the persisted editor and cover separately.
  if (expectedHtml === undefined && !coverUrl) return { confirmed: true };
  const expectedBodyText = expectedHtml === undefined ? "" : compactArticleText(expectedHtml);
  if (expectedHtml !== undefined && !expectedBodyText) {
    return { confirmed: false, reason: "头条草稿正文没有可验证的文本" };
  }
  let editPage = null;
  let verificationStage = "open";
  try {
    const entry = await page.evaluate(expected => {
      for (const element of document.querySelectorAll("[data-ebao-draft-edit]")) {
        element.removeAttribute("data-ebao-draft-edit");
      }
      const titles = [...document.querySelectorAll("a,span,p,div,h1,h2,h3,h4")]
        .filter(element => element.getBoundingClientRect().width > 0
          && String(element.textContent || "").trim() === expected
          && ![...element.children].some(child => String(child.textContent || "").trim() === expected));
      if (titles.length !== 1) return null;
      for (let row = titles[0]; row && row !== document.body; row = row.parentElement) {
        const controls = [...row.querySelectorAll("a,button,[role='link'],[role='button']")]
          .filter(element => element.getBoundingClientRect().width > 0
            && String(element.textContent || "").trim() === "编辑");
        if (controls.length !== 1) continue;
        controls[0].setAttribute("data-ebao-draft-edit", "true");
        return { editHref: controls[0].getAttribute?.("href") || "" };
      }
      return null;
    }, title);
    if (!entry) return { confirmed: false, reason: "头条草稿箱未找到这篇文章的唯一编辑入口" };

    let editHref = "";
    try {
      const candidate = new URL(entry.editHref, "https://mp.toutiao.com");
      if (candidate.origin === "https://mp.toutiao.com"
        && candidate.pathname === "/profile_v4/graphic/publish"
        && candidate.searchParams.has("pgc_id")) editHref = candidate.href;
    } catch { /* The edit control may navigate through a click handler. */ }

    const browser = typeof page.browser === "function" ? page.browser() : null;
    const previousTargets = new Set(browser?.targets?.() || []);
    const isEditTarget = target => {
      if (previousTargets.has(target)) return false;
      try {
        const url = new URL(target.url());
        return url.origin === "https://mp.toutiao.com"
          && url.pathname === "/profile_v4/graphic/publish" && url.searchParams.has("pgc_id");
      } catch { return false; }
    };
    const popup = browser?.waitForTarget && browser?.targets
      ? browser.waitForTarget(isEditTarget, { timeout: 15000 })
        .then(target => {
          const matches = browser.targets().filter(isEditTarget);
          return matches.length === 1 && matches[0] === target ? target.page() : null;
        }).catch(() => null)
      : Promise.resolve(null);
    await page.click("[data-ebao-draft-edit='true']");
    editPage = await popup || page;
    if (editPage === page && editHref && page.url?.() !== editHref) {
      await page.goto(editHref, { waitUntil: "domcontentloaded", timeout: 15000 });
    }
    const editor = await findArticleEditor(editPage);
    verificationStage = "body";
    await editPage.waitForFunction((titleSelector, editorSelector, expectedTitle, bodyText) => {
      if (String(document.querySelector(titleSelector)?.value || "").trim() !== expectedTitle) return false;
      if (!bodyText) return true;
      const text = String(document.querySelector(editorSelector)?.textContent || "")
        .normalize("NFC").replace(/[\s\u200B-\u200D\uFEFF\uFFFC]+/gu, "");
      return text.includes(bodyText);
    }, { timeout: 15000 }, TITLE_SELECTOR, editor, title, expectedBodyText);
    if (coverUrl) {
      verificationStage = "cover";
      await editPage.waitForFunction(expectedUrl => {
        const area = document.querySelector(".article-cover-images-wrap");
        if (!area || area.getBoundingClientRect().width <= 0) return false;
        const expected = new URL(expectedUrl);
        const images = [...area.querySelectorAll("img")]
          .filter(image => image.complete && image.naturalWidth > 0);
        const urls = image => [image.currentSrc, image.src, image.getAttribute("src")]
          .filter(Boolean).map(value => { try { return new URL(value, location.href); } catch { return null; } })
          .filter(Boolean);
        const exact = images.filter(image => urls(image).some(url => url.href === expected.href));
        if (exact.length) return exact.length === 1;
        if (expected.pathname.length <= 1) return false;
        const samePath = images.filter(image => urls(image).some(url => url.pathname === expected.pathname));
        return samePath.length === 1;
      }, { timeout: 15000 }, coverUrl);
    }
    return { confirmed: true };
  } catch {
    const reason = verificationStage === "cover" ? "头条草稿重新打开后未确认封面"
      : verificationStage === "body" ? "头条草稿重新打开后未确认完整正文"
        : "头条草稿箱未能重新打开这篇文章的编辑页";
    return { confirmed: false, reason };
  } finally {
    if (editPage && editPage !== page) {
      try { await editPage.close(); } catch { /* The browser may already be closed. */ }
    }
  }
}

export function renderUploadedArticle(data, uploadedUrls) {
  const assets = (data.data?.images || []).map(image => ({ id: image.id }));
  return renderArticleHtml({ body: data.data.content, assets }, uploadedUrls);
}

/** Optional draft metadata must not be silently discarded by a site adapter. */
export async function fillArticleMetadata(page, data) {
  const summary = String(data.data?.summary || "").trim();
  if (summary) {
    const selector = "textarea[placeholder*='摘要'],input[placeholder*='摘要']";
    const field = await page.$(selector);
    if (!field) throw new Error("平台文章摘要字段不可用，请清空摘要后重试");
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type(selector, summary, { delay: 15 });
    const actual = await page.$eval(selector, element => element.value || "");
    if (actual.trim() !== summary) throw new Error("平台文章摘要未写入");
  }
}

export async function clickArticleAction(page, labels, scope = "") {
  const found = await page.evaluate((choices, within) => {
    const root = within ? document.querySelector(within) : document;
    if (!root) return false;
    const normalize = text => String(text || "").replace(/\s+/gu, "").trim();
    const elements = [...root.querySelectorAll("button,[role='button']")];
    const target = elements.find(element => {
      if (element.disabled || element.getAttribute("aria-disabled") === "true") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && choices.some(label => normalize(element.textContent) === label);
    });
    if (!target) return false;
    target.click();
    return true;
  }, labels, scope);
  if (!found) throw new Error(`未找到可用的「${labels[0]}」操作`);
}

const NOTICE_SELECTOR = "[role='alert'],[class*='toast'],[class*='Toast'],[class*='message'],[class*='Message'],[class*='notice'],[class*='Notice']";

export async function captureArticleNotices(page) {
  return page.evaluate(selector => [...document.querySelectorAll(selector)]
    .filter(item => item.getBoundingClientRect().width > 0)
    .map(item => String(item.textContent || "")), NOTICE_SELECTOR);
}

export async function confirmPlatformOutcome(page, kind, beforeUrl, priorNotices = [], timeout = 12000) {
  try {
    await page.waitForFunction((mode, previous, existing) => {
      const url = location.href;
      const notices = [...document.querySelectorAll("[role='alert'],[class*='toast'],[class*='Toast'],[class*='message'],[class*='Message'],[class*='notice'],[class*='Notice']")]
        .filter(item => {
          const rect = item.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }).map(item => String(item.textContent || ""));
      const positive = mode === "draft" ? /保存成功|保存草稿成功|已保存到草稿|草稿已保存|已存入草稿/u : /发布成功|提交审核成功|提交成功|发布完成/u;
      if (notices.some(text => !existing.includes(text) && positive.test(text))) return true;
      if (url !== previous && mode === "draft" && /(?:\/draft(?:s)?(?:\/|\?|$)|草稿)/iu.test(url)) return true;
      if (url !== previous && mode === "publish" && /(?:\/success(?:\/|\?|$)|\/publish-success(?:\/|\?|$))/iu.test(url)) return true;
      return false;
    }, { timeout }, kind, beforeUrl, priorNotices);
    return true;
  } catch { return false; }
}

export async function finishArticle(page, data, window, event, kind, beforeUrl, confirmed) {
  if (!confirmed) {
    await replyPublishFailure({
      page, data, window, event,
      message: `${data.pt}${kind === "draft" ? "草稿保存" : "直接发布"}后未获得明确确认，请到平台后台检查`,
      extraPayload: { publishAbnormal: true, needsAttention: true },
      closeWindow: true,
    });
    return;
  }
  await replyPublishOutcome({
    page, data, window, event, urlBefore: "", isDraftMode: kind === "draft", waitMs: 0,
    successMessage: kind === "draft" ? "平台草稿已保存" : "平台已确认文章提交",
  });
}

export async function failArticle(page, data, window, event, error, afterClick = false) {
  await replyPublishFailure({
    page, data, window, event,
    message: error?.message || String(error),
    extraPayload: afterClick ? { publishAbnormal: true, needsAttention: true } : {},
    closeWindow: true,
  });
}

export function currentUrl(page) { return readPageUrl(page); }
