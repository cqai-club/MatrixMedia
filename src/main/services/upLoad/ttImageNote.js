"use strict";

import { replyPublishFailure, replyPublishOutcome, readPageUrl } from "./publishOutcome.js";
import { WAIT_SELECTOR_APPEAR_MS } from "./uploadTimeouts.js";

const EDITOR = ".ProseMirror[contenteditable='true']";
const IMAGE_INPUT = "input[type='file'][accept='image/*'][multiple]:not(#upload-drag-input)";
const SAVE_BUTTON = "button.save-draft";
const MAX_IMAGES = 9;
const UPLOAD_WAIT_MS = 5 * 60 * 1000;
const SAVE_WAIT_MS = 30 * 1000;

function paragraphText(value) {
  return String(value || "").normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF\uFFFC]/gu, "")
    .replace(/\u00A0/gu, " ");
}

export function composeToutiaoImageNoteText({ title, description, tags } = {}) {
  const heading = String(title || "").trim();
  if (!heading) throw new Error("头条图文标题不能为空");
  if (/[\r\n]/u.test(heading)) throw new Error("头条图文标题不能换行");
  const body = String(description || "").trim().replace(/\r\n?/gu, "\n");
  const hashtags = [...new Set((Array.isArray(tags) ? tags : [])
    .map(tag => String(tag || "").replace(/^#+/u, "").trim())
    .filter(Boolean))].map(tag => `#${tag}`);
  return [heading, body, hashtags.join(" ")].filter(Boolean).join("\n\n");
}

export function classifyToutiaoImageNoteFeedback(labels) {
  const values = Array.isArray(labels) ? labels.map(label => String(label || "").replace(/\s+/gu, "").trim()) : [];
  if (values.some(label => /^(?:草稿保存失败|保存草稿失败|存草稿失败)$/u.test(label))) return "failed";
  if (values.some(label => /^(?:已存草稿|已保存到草稿箱|保存草稿成功|草稿保存成功|存草稿成功)$/u.test(label))) return "saved";
  return "";
}

async function pageFeedback(page) {
  return page.evaluate(() => [...document.querySelectorAll("span,div,p,[role='alert'],[role='status']")]
    .filter(element => {
      const box = element.getBoundingClientRect();
      const text = String(element.textContent || "").trim();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden"
        && text && ![...element.children].some(child => String(child.textContent || "").trim() === text);
    })
    .map(element => String(element.textContent || "").trim())).catch(() => []);
}

async function findImageButton(page) {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".syl-toolbar-button")].filter(element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && String(element.textContent || "").trim() === "图片";
    });
    if (buttons.length !== 1) return false;
    buttons[0].setAttribute("data-ebao-tt-note-image", "true");
    return true;
  });
}

async function recordImageBaseline(page) {
  return page.evaluate(editorSelector => {
    const editor = document.querySelector(editorSelector);
    const root = editor?.closest(".publish-box");
    if (!root) return null;
    root.setAttribute("data-ebao-tt-note-root", "true");
    const urls = [...root.querySelectorAll("img")]
      .filter(image => !image.closest(".wtt-editor-toolbar,.syl-toolbar,button")
        && image.getBoundingClientRect().width >= 40 && image.getBoundingClientRect().height >= 40)
      .map(image => image.currentSrc || image.src || image.getAttribute("src"))
      .filter(Boolean);
    return urls;
  }, EDITOR);
}

async function uploadedImageUrls(page, before) {
  return page.evaluate(knownUrls => {
    const root = document.querySelector("[data-ebao-tt-note-root='true']");
    if (!root) return null;
    const editor = root.querySelector(".ProseMirror[contenteditable='true']");
    const save = document.querySelector("button.save-draft");
    if (!editor || !save) return null;
    const editorBox = editor.getBoundingClientRect();
    const saveBox = save.getBoundingClientRect();
    const region = {
      left: Math.min(editorBox.left, saveBox.left) - 50,
      right: Math.max(editorBox.right, saveBox.right) + 50,
      top: Math.min(editorBox.top, saveBox.top) - 50,
      bottom: Math.max(editorBox.bottom, saveBox.bottom) + 50,
    };
    const old = new Set(knownUrls);
    const images = [...root.querySelectorAll("img")].filter(image => {
      if (image.closest(".wtt-editor-toolbar,.syl-toolbar,button")) return false;
      const box = image.getBoundingClientRect();
      const centerX = box.left + box.width / 2;
      const centerY = box.top + box.height / 2;
      const url = image.currentSrc || image.src || image.getAttribute("src");
      let remotelyLoaded = false;
      try { remotelyLoaded = /^https?:$/u.test(new URL(url, location.href).protocol); }
      catch { /* A blob or local preview is not proof of completed upload. */ }
      return box.width >= 40 && box.height >= 40 && image.complete && image.naturalWidth > 0
        && centerX >= region.left && centerX <= region.right
        && centerY >= region.top && centerY <= region.bottom
        && remotelyLoaded && !old.has(url);
    });
    return images.map(image => image.currentSrc || image.src || image.getAttribute("src"));
  }, before).catch(() => null);
}

async function verifyImages(page, paths, before) {
  const deadline = Date.now() + UPLOAD_WAIT_MS;
  while (Date.now() < deadline) {
    const urls = await uploadedImageUrls(page, before);
    if (urls?.length === paths.length) return urls;
    await page.waitForTimeout(1000);
  }
  throw new Error("头条图文图片上传未在编辑页完整确认");
}

async function verifyImageOrderUnchanged(page, before, uploadedUrls) {
  const current = await uploadedImageUrls(page, before);
  if (!current || current.length !== uploadedUrls.length
    || current.some((url, index) => url !== uploadedUrls[index])) {
    throw new Error("头条图文图片在写入文案后数量或顺序发生变化，已停止存草稿");
  }
}

async function readEditorParagraphs(page) {
  return page.evaluate(selector => {
    const editor = document.querySelector(selector);
    if (!editor) return null;
    return [...editor.children].filter(child => child.tagName === "P")
      .map(child => String(child.textContent || ""));
  }, EDITOR);
}

function paragraphsMatch(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((paragraph, index) => paragraphText(paragraph) === paragraphText(expected[index]));
}

/** Toutiao's microheadline editor is a distinct image-note path, not its article editor. */
export default async function publishToutiaoImageNote(page, data, window, event) {
  let uploadStarted = false;
  let clickedSave = false;
  try {
    if (data.publishToDraft !== true) throw new Error("头条图文直接发布尚未验收，请先转存草稿");
    const url = new URL(readPageUrl(page));
    if (url.origin !== "https://mp.toutiao.com" || url.pathname !== "/profile_v4/weitoutiao/publish") {
      throw new Error("当前不是头条微头条编辑页");
    }
    const paths = data.imagePaths;
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_IMAGES
      || paths.some(path => typeof path !== "string" || !path)) {
      throw new Error("头条图文图片数量无效");
    }
    const content = composeToutiaoImageNoteText(data.data);
    await page.waitForSelector(EDITOR, { visible: true, timeout: WAIT_SELECTOR_APPEAR_MS });
    const empty = await page.evaluate(selector => !String(document.querySelector(selector)?.textContent || "").trim(), EDITOR);
    if (!empty) throw new Error("头条图文编辑器已有内容，请先人工确认，未覆盖原内容");
    const baseline = await recordImageBaseline(page);
    if (!baseline) throw new Error("头条图文编辑区域无法定位");
    if (!await findImageButton(page)) throw new Error("未找到唯一的头条图文图片入口");
    await page.click("[data-ebao-tt-note-image='true']");
    await page.waitForSelector(IMAGE_INPUT, { timeout: WAIT_SELECTOR_APPEAR_MS });
    const input = await page.$(IMAGE_INPUT);
    if (!input) throw new Error("未找到头条图文图片输入框");
    if (window && !window.isDestroyed()) window._mmRetainedForInspection = true;
    uploadStarted = true;
    await input.uploadFile(...paths);
    const uploadedUrls = await verifyImages(page, paths, baseline);

    await page.click(EDITOR);
    const paragraphs = content.split("\n");
    for (const [index, paragraph] of paragraphs.entries()) {
      if (index > 0) await page.keyboard.press("Enter");
      if (paragraph) await page.keyboard.sendCharacter(paragraph);
    }
    if (!paragraphsMatch(await readEditorParagraphs(page), paragraphs)) {
      throw new Error("头条图文文案未按段落完整进入编辑器");
    }
    await page.waitForFunction((selector, expectedParagraphs) => {
      const buttons = [...document.querySelectorAll(selector)].filter(button => {
        const box = button.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && String(button.textContent || "").trim() === "存草稿";
      });
      const editor = document.querySelector(".ProseMirror[contenteditable='true']");
      const actualParagraphs = editor
        ? [...editor.children].filter(child => child.tagName === "P").map(child => String(child.textContent || ""))
        : [];
      const normalize = value => String(value || "").normalize("NFC")
        .replace(/[\u200B-\u200D\uFEFF\uFFFC]/gu, "")
        .replace(/\u00A0/gu, " ");
      return buttons.length === 1 && !buttons[0].disabled && buttons[0].getAttribute("aria-disabled") !== "true"
        && actualParagraphs.length === expectedParagraphs.length
        && actualParagraphs.every((paragraph, index) => normalize(paragraph) === normalize(expectedParagraphs[index]));
    }, { timeout: 10000 }, SAVE_BUTTON, paragraphs);
    const beforeFeedback = classifyToutiaoImageNoteFeedback(await pageFeedback(page));
    if (beforeFeedback === "saved") throw new Error("头条图文保存提示在操作前已存在，无法确认本次草稿");
    const marked = await page.evaluate(selector => {
      const buttons = [...document.querySelectorAll(selector)].filter(button => {
        const box = button.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && String(button.textContent || "").trim() === "存草稿";
      });
      if (buttons.length !== 1) return false;
      buttons[0].setAttribute("data-ebao-tt-note-save", "true");
      return true;
    }, SAVE_BUTTON);
    if (!marked) throw new Error("未找到唯一的头条图文存草稿按钮");
    await verifyImageOrderUnchanged(page, baseline, uploadedUrls);
    if (!paragraphsMatch(await readEditorParagraphs(page), paragraphs)) {
      throw new Error("头条图文文案在存草稿前发生变化，已停止提交");
    }
    clickedSave = true;
    await page.click("[data-ebao-tt-note-save='true']");
    let feedback = "";
    const deadline = Date.now() + SAVE_WAIT_MS;
    while (Date.now() < deadline) {
      feedback = classifyToutiaoImageNoteFeedback(await pageFeedback(page));
      if (feedback) break;
      await page.waitForTimeout(500);
    }
    if (feedback !== "saved") throw new Error(feedback === "failed"
      ? "头条页面提示图文草稿保存失败，请人工核查"
      : "头条图文存草稿后未获得明确成功提示，请到平台草稿箱核查");
    await replyPublishOutcome({
      page, data, window, event, urlBefore: "", isDraftMode: true, waitMs: 0,
      successMessage: "头条微头条图文草稿已保存",
    });
  } catch (error) {
    await replyPublishFailure({
      page, data, window, event,
      message: uploadStarted
        ? `${error?.message || String(error)}；图片或草稿可能已进入头条，请先到平台后台核查，勿直接重复提交`
        : error?.message || String(error),
      extraPayload: uploadStarted || clickedSave ? { publishAbnormal: true, needsAttention: true } : {},
      closeWindow: true,
    });
  }
}
