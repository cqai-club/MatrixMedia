"use strict";

import { replyPublishFailure, replyPublishOutcome, readPageUrl } from "./publishOutcome.js";
import { WAIT_SELECTOR_APPEAR_MS, WAIT_UPLOAD_PROCESSING_MS, pollPageUntil } from "./uploadTimeouts.js";
import { selectXhsCreativeStatement } from "./xhs.js";

/** XHS image-note editor. This handler is gated by Worker capabilities until live acceptance. */
export default async function publishXhsImageNote(page, data, window, event) {
  const isDraftMode = data.publishToDraft === true;
  try {
    const paths = data.imagePaths || [];
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 20) throw new Error("图文图片数量无效");
    const inputSelector = "input.upload-input[type='file'],input[type='file'][accept*='image']";
    await page.waitForSelector(inputSelector, { visible: false, timeout: WAIT_SELECTOR_APPEAR_MS });
    const input = await page.$(inputSelector);
    if (!input) throw new Error("未找到小红书图文上传入口");
    await input.uploadFile(...paths);
    await pollPageUntil(page,
      `(function(){return document.querySelectorAll('.img-card,.image-card,.upload-image-item,.image-item').length>=${paths.length};})()`,
      Math.min(WAIT_UPLOAD_PROCESSING_MS, 5 * 60 * 1000), 1000,
      "等待小红书图文图片上传完成超时");

    const titleSelector = ".publish-page-content-base .edit-container .d-input input.d-text";
    await page.waitForSelector(titleSelector, { visible: true, timeout: WAIT_SELECTOR_APPEAR_MS });
    await page.click(titleSelector, { clickCount: 3 });
    await page.keyboard.press("Backspace");
    const title = String(data.data?.title || "");
    if (title.length > 20) throw new Error("小红书图文标题不能超过20字");
    await page.type(titleSelector, title, { delay: 60 });
    const editorSelector = ".tiptap.ProseMirror";
    await page.waitForSelector(editorSelector, { visible: true, timeout: WAIT_SELECTOR_APPEAR_MS });
    await page.click(editorSelector);
    const body = String(data.data?.description || "");
    if (body) await page.keyboard.type(body, { delay: 20 });
    const tags = Array.isArray(data.data?.tags) ? data.data.tags : [];
    for (const tag of tags) {
      await page.keyboard.press("Enter");
      await page.keyboard.type(`#${tag}`, { delay: 50 });
      await page.waitForTimeout(900);
      await page.keyboard.press("Enter");
    }
    const written = await page.evaluate(selector => {
      const editor = document.querySelector(selector);
      return Boolean(editor && String(editor.textContent || "").trim());
    }, editorSelector);
    if (body && !written) throw new Error("小红书图文正文未写入");
    const statementSelected = await selectXhsCreativeStatement(page, data);
    if (data.data?.creativeStatement !== "none" && !statementSelected) {
      throw new Error("小红书内容声明未确认选中，请在平台后台检查后重试");
    }

    const host = await page.waitForSelector("xhs-publish-btn", { visible: true, timeout: WAIT_SELECTOR_APPEAR_MS });
    if (!host) throw new Error("未找到小红书提交按钮");
    const box = await host.boundingBox();
    if (!box) throw new Error("小红书提交按钮不可见");
    const disabled = await page.evaluate(draft => {
      const element = document.querySelector("xhs-publish-btn");
      return element?.getAttribute(draft ? "save-disabled" : "submit-disabled");
    }, isDraftMode);
    if (disabled === "true") throw new Error("小红书提交按钮不可用，请检查页面必填项");
    const before = readPageUrl(page);
    await page.mouse.click(box.x + (isDraftMode ? 300 : 450), box.y + 40, { delay: 80 });
    await page.waitForTimeout(3500);
    const stillThere = await page.evaluate(() => Boolean(document.querySelector("xhs-publish-btn")));
    if (stillThere) throw new Error("小红书提交按钮仍在，未确认操作生效");
    await replyPublishOutcome({
      page, data, window, event, urlBefore: before, isDraftMode,
      successMessage: isDraftMode ? "图文草稿已提交" : "图文已提交",
    });
  } catch (error) {
    await replyPublishFailure({
      page, data, window, event,
      message: error?.message || String(error),
      closeWindow: true,
    });
  }
}
