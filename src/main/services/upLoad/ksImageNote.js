"use strict";

import { readPageUrl, replyPublishFailure } from "./publishOutcome.js";
import { capturePublishFailureScreenshot } from "./failureScreenshot.js";
import { WAIT_SELECTOR_APPEAR_MS } from "./uploadTimeouts.js";

const DESCRIPTION_SELECTOR = "#work-description-edit";
const IMAGE_INPUT_SELECTOR = "input[type='file'][accept*='image']";

export function isKsImageNoteEditorUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://cp.kuaishou.com"
      && url.pathname === "/article/publish/video"
      && url.searchParams.get("tabType") === "2";
  } catch {
    return false;
  }
}

// 快手图文页只有作品描述输入框，标题作为第一行写入描述。
export function buildKsImageNoteDescription(content = {}) {
  const title = String(content.title || "").trim();
  const body = String(content.description || "").trim();
  const tags = Array.isArray(content.tags) ? content.tags
    .map(tag => String(tag || "").trim().replace(/^#+/u, ""))
    .filter(Boolean)
    .map(tag => `#${tag}`) : [];
  const paragraphs = [];
  if (title) paragraphs.push(title);
  if (body && body !== title) paragraphs.push(body);
  if (tags.length) paragraphs.push(tags.join(" "));
  return paragraphs.join("\n\n");
}

async function reportUnconfirmed(page, data, window, event, message) {
  const shot = await capturePublishFailureScreenshot(page, data);
  if (window && !window.isDestroyed()) {
    window._mmRetainedForInspection = true;
    try { window.show(); window.focus(); } catch { /* 保留任务截图和未确认回执。 */ }
  }
  event.reply("puppeteerFile-done", {
    ...data, status: false, needsAttention: true, message,
    ...(shot ? { failScreenshot: shot } : {}),
  });
}

/**
 * 快手图文编辑页会通过 saveImageSnapshot/getSnapshotInfo 自动保存。公开页面
 * 尚没有稳定的草稿确认字段，填充后保留页面交由用户核对，不能报告“保存成功”。
 * 这里绝不查找或点击“发布”按钮；发布模式在任何上传动作前就终止。
 */
export default async function publishKsImageNote(page, data, window, event) {
  let editorTouched = false;
  try {
    if (data.publishToDraft !== true) {
      throw new Error("快手图文立即发布尚未验收，已停止提交；未点击发布");
    }
    if (!isKsImageNoteEditorUrl(readPageUrl(page))) {
      throw new Error("当前不是快手图文编辑页，已停止提交");
    }
    const paths = data.imagePaths;
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 31
      || paths.some(file => typeof file !== "string" || !file)) {
      throw new Error("快手图文需要 1 至 31 张图片");
    }
    const description = buildKsImageNoteDescription(data.data);
    if (!description) throw new Error("快手图文标题和正文不能为空");

    const input = await page.waitForSelector(IMAGE_INPUT_SELECTOR, {
      visible: false, timeout: WAIT_SELECTOR_APPEAR_MS,
    });
    if (!input) throw new Error("未找到快手图文图片上传入口");
    editorTouched = true;
    await input.uploadFile(...paths);

    await page.waitForSelector(DESCRIPTION_SELECTOR, {
      visible: true, timeout: WAIT_SELECTOR_APPEAR_MS,
    });
    await page.click(DESCRIPTION_SELECTOR);
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.down(modifier);
    try {
      await page.keyboard.press("A");
    } finally {
      await page.keyboard.up(modifier);
    }
    await page.keyboard.press("Backspace");
    await page.keyboard.type(description, { delay: 15 });
    // 失焦允许页面触发自己的自动快照，不调用内部接口，也不点击提交按钮。
    await page.keyboard.press("Tab");
    const written = await page.evaluate(selector => {
      const editor = document.querySelector(selector);
      return editor ? String(editor.value ?? editor.innerText ?? editor.textContent ?? "") : null;
    }, DESCRIPTION_SELECTOR);
    const normalize = value => String(value || "").replace(/\r\n?/gu, "\n").trim();
    if (normalize(written) !== normalize(description)) {
      throw new Error("快手图文描述未完整写入，已停止提交");
    }
    await reportUnconfirmed(page, data, window, event,
      "快手图文已填入编辑页；图片上传和自动草稿保存尚未确认，请到快手后台核对");
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
