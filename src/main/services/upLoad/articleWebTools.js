"use strict";

import { clipboard } from "electron";
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

export async function pasteArticleHtml(page, editor, html, plain, context = page, expectedImages = []) {
  const saved = { html: clipboard.readHTML(), text: clipboard.readText() };
  try {
    clipboard.write({ html, text: plain });
    await context.click(editor);
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.down(modifier);
    try {
      await page.keyboard.press("KeyA");
      await page.keyboard.press("KeyV");
    }
    finally { await page.keyboard.up(modifier).catch(() => {}); }
  } finally {
    clipboard.write(saved);
  }
  const probe = plain.split(/\r?\n/u)
    .map(line => line.replace(/!\[[^\]]*\]\([^)]*\)/gu, "").replace(/^\s*(?:#+|>)\s*/u, "").trim())
    .find(Boolean)?.slice(0, 16) || "";
  const written = await context.evaluate((selector, expected, images) => {
    const element = document.querySelector(selector);
    if (!element || !expected || !(element.textContent || "").includes(expected)) return false;
    const actualImages = [...element.querySelectorAll("img")].map(img => img.getAttribute("src"));
    return images.every(url => actualImages.includes(url));
  }, editor, probe, expectedImages);
  if (!written) throw new Error("文章正文未写入");
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
