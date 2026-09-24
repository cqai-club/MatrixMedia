"use strict";

import { readPageUrl, replyPublishFailure } from "./publishOutcome.js";
import { capturePublishFailureScreenshot } from "./failureScreenshot.js";
import { WAIT_SELECTOR_APPEAR_MS } from "./uploadTimeouts.js";

const IMAGE_INPUT_SELECTOR = 'input[type="file"][multiple][accept*="image"]';
const TITLE_SELECTOR = 'input[placeholder*="作品标题"],input[placeholder*="标题"]';
const BODY_SELECTOR = '[contenteditable="true"]';

export function isDouyinImageNoteEditorUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://creator.douyin.com"
      && url.pathname === "/creator-micro/content/upload"
      && url.searchParams.get("default-tab") === "3";
  } catch {
    return false;
  }
}

export function buildDouyinImageNoteBody(content = {}) {
  const body = String(content.description || "").trim();
  const tags = Array.isArray(content.tags) ? content.tags
    .map(tag => String(tag || "").trim().replace(/^#+/u, ""))
    .filter(Boolean)
    .map(tag => `#${tag}`) : [];
  return [body, tags.join(" ")].filter(Boolean).join("\n\n");
}

async function replaceFocusedText(page, text) {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  try { await page.keyboard.press("A"); }
  finally { await page.keyboard.up(modifier); }
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text, { delay: 15 });
}

async function reportUnconfirmed(page, data, window, event, message) {
  const shot = await capturePublishFailureScreenshot(page, data);
  if (window && !window.isDestroyed()) {
    window._mmRetainedForInspection = true;
    try { window.show(); window.focus(); } catch { /* 截图和回执仍可用。 */ }
  }
  event.reply("puppeteerFile-done", {
    ...data, status: false, needsAttention: true, message,
    ...(shot ? { failScreenshot: shot } : {}),
  });
}

/**
 * 抖音图文草稿页面尚无已验收的独立“存草稿”动作及成功回执。
 * 本适配器仅填入并回读内容，然后保留窗口供用户检查；绝不点击“发布”。
 */
export default async function publishDouyinImageNote(page, data, window, event) {
  let editorTouched = false;
  try {
    if (data.publishToDraft !== true) {
      throw new Error("抖音图文立即发布尚未验收，已停止提交；未点击发布");
    }
    if (!isDouyinImageNoteEditorUrl(readPageUrl(page))) {
      throw new Error("当前不是抖音图文编辑页，已停止提交");
    }
    const paths = data.imagePaths;
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 35
      || paths.some(file => typeof file !== "string" || !file)) {
      throw new Error("抖音图文需要 1 至 35 张图片");
    }
    const title = String(data.data?.title || "").trim();
    const body = buildDouyinImageNoteBody(data.data);
    if (!title || !body) throw new Error("抖音图文标题和正文不能为空");

    const input = await page.waitForSelector(IMAGE_INPUT_SELECTOR, {
      visible: false, timeout: WAIT_SELECTOR_APPEAR_MS,
    });
    if (!input) throw new Error("未找到抖音图文图片上传入口");
    editorTouched = true;
    await input.uploadFile(...paths);

    await page.waitForSelector(TITLE_SELECTOR, {
      visible: true, timeout: WAIT_SELECTOR_APPEAR_MS,
    });
    await page.click(TITLE_SELECTOR);
    await replaceFocusedText(page, title);
    await page.waitForSelector(BODY_SELECTOR, {
      visible: true, timeout: WAIT_SELECTOR_APPEAR_MS,
    });
    await page.click(BODY_SELECTOR);
    await replaceFocusedText(page, body);
    const written = await page.evaluate((titleSelector, bodySelector) => {
      const titleInput = document.querySelector(titleSelector);
      const editor = document.querySelector(bodySelector);
      return {
        title: titleInput ? String(titleInput.value ?? "") : null,
        body: editor ? String(editor.innerText ?? editor.textContent ?? "") : null,
      };
    }, TITLE_SELECTOR, BODY_SELECTOR);
    const normalize = value => String(value || "").replace(/\r\n?/gu, "\n").trim();
    if (normalize(written.title) !== normalize(title)) {
      throw new Error("抖音图文标题未完整写入，已停止提交");
    }
    if (normalize(written.body) !== normalize(body)) {
      throw new Error("抖音图文正文未完整写入，已停止提交");
    }
    await reportUnconfirmed(page, data, window, event,
      "抖音图文已填入编辑页；图片上传和草稿保存尚未确认，请在抖音后台核对");
  } catch (error) {
    if (editorTouched) {
      await reportUnconfirmed(page, data, window, event, error?.message || String(error));
      return;
    }
    await replyPublishFailure({
      page, data, window, event,
      message: error?.message || String(error),
      closeWindow: true,
    });
  }
}
