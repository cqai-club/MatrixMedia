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

export async function fillArticleTitle(page, title) {
  await page.waitForSelector(TITLE_SELECTOR, { visible: true, timeout: 25000 });
  await page.click(TITLE_SELECTOR, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(TITLE_SELECTOR, title, { delay: 25 });
  const actual = await page.$eval(TITLE_SELECTOR, element => element.value || "");
  if (actual.trim() !== title.trim()) throw new Error("文章标题未写入");
}

export async function pasteArticleHtml(page, editor, html, plain, context = page, expectedImages = [], options = {}) {
  const probe = plain.split(/\r?\n/u)
    .map(line => line.replace(/!\[[^\]]*\]\([^)]*\)/gu, "").replace(/^\s*(?:#+|>)\s*/u, "").trim())
    .find(Boolean)?.slice(0, 16) || "";
  if (!probe) throw new Error("文章正文没有可验证的文本");
  await context.click(editor);
  const before = await context.evaluate(selector => document.querySelector(selector)?.innerHTML || "", editor);
  const written = async () => {
    try {
      await context.waitForFunction((selector, expected, images) => {
        const element = document.querySelector(selector);
        if (!element || !(element.textContent || "").includes(expected)) return false;
        const actualImages = [...element.querySelectorAll("img")].map(img => img.getAttribute("src"));
        return images.every(url => actualImages.includes(url));
      }, { timeout: 1800 }, editor, probe, expectedImages);
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

/** Keep only the business code; never persist response bodies or request content. */
export function observeToutiaoDraftSave(page) {
  let error = "";
  const onResponse = async response => {
    try {
      const url = new URL(response.url());
      if (url.origin !== "https://mp.toutiao.com" || url.pathname !== "/mp/agw/article/publish"
        || response.request().method() !== "POST") return;
      const result = await response.json();
      if (Number.isSafeInteger(result.code)) {
        error = result.code === 0 ? "" : `头条草稿保存接口拒绝（错误码 ${result.code}）`;
      }
    } catch { /* Navigation can dispose a response before its body is available. */ }
  };
  page.on("response", onResponse);
  return { error: () => error, stop: () => page.off("response", onResponse) };
}

/** Toutiao's article editor autosaves; verify both its indicator and Drafts list. */
export async function confirmToutiaoDraftAutosave(page, title, timeout = 30000, saveError = () => "") {
  try {
    const marker = await page.waitForFunction(() => {
      const labels = [...document.querySelectorAll("span,div,p")]
        .map(element => String(element.textContent || "").replace(/\s+/gu, "").trim());
      if (labels.some(label => /^(?:保存失败|草稿保存失败|自动保存失败)$/u.test(label))) return "failed";
      if (labels.some(label => /^(?:草稿已保存|草稿保存成功|保存草稿成功|已自动保存|自动保存成功|已保存到草稿箱|已保存至草稿箱)$/u.test(label))) return "saved";
      return false;
    }, { timeout });
    const status = await marker.jsonValue();
    await marker.dispose();
    if (status === "failed") return { confirmed: false, reason: saveError() || "头条页面提示草稿保存失败" };
    await page.goto("https://mp.toutiao.com/profile_v4/manage/draft", {
      waitUntil: "domcontentloaded", timeout: 15000,
    });
    await page.waitForFunction(expected => String(document.body?.innerText || "").includes(expected),
      { timeout: 15000 }, title);
    return { confirmed: true };
  } catch { return { confirmed: false, reason: saveError() || "头条草稿箱未确认这篇文章" }; }
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
