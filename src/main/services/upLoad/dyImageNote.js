"use strict";

import path from "path";
import { readPageUrl, replyPublishFailure } from "./publishOutcome.js";
import { capturePublishFailureScreenshot } from "./failureScreenshot.js";
import maybeClosePublishWindow from "./closeWindow.js";
import { WAIT_SELECTOR_APPEAR_MS, WAIT_UPLOAD_PROCESSING_MS } from "./uploadTimeouts.js";
import { getCreativeStatementOptionsForPlatform, resolveDyCreativeStatementLabel } from "../../../shared/creativeStatement.js";

const IMAGE_INPUT_SELECTOR = 'input[type="file"][multiple][accept*="image"]';
const TITLE_SELECTOR = 'input[placeholder*="作品标题"],input[placeholder*="标题"]';
const BODY_SELECTOR = '[contenteditable="true"]';
const PREVIEW_SELECTOR = '.semi-upload-file-list,[class*="image-list"],[class*="imageList"],[class*="image-preview"],[class*="imagePreview"],[class*="image-item"],[class*="imageItem"],[class*="upload-list"],[class*="uploadList"],[class*="upload-item"],[class*="uploadItem"]';
const RESULT_WAIT_MS = Math.min(WAIT_SELECTOR_APPEAR_MS, 45_000);

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
    .map(tag => "#" + tag) : [];
  return [body, tags.join(" ")].filter(Boolean).join("\n\n");
}

/** 浏览器内执行：只计上传列表内已加载的远程图片，不把 blob 本地预览算上传成功。 */
export function readDouyinImageUploadState(previewSelector, expectedNames = null) {
  const visible = element => {
    const box = element?.getBoundingClientRect();
    return Boolean(box && box.width > 0 && box.height > 0);
  };
  const roots = [...document.querySelectorAll(previewSelector)].filter(visible);
  const images = [...new Set(roots.flatMap(root => [...root.querySelectorAll("img")]))].filter(visible);
  const busy = roots.some(root => [...root.querySelectorAll('[role="progressbar"],[aria-busy="true"],.semi-spin,[class*="uploading"],[class*="upload-error"]')].some(visible));
  const urls = images.map(image => String(image.currentSrc || image.getAttribute("src") || ""));
  const snapshot = { ready: false, count: images.length, urls };
  const failure = roots.some(root => /上传失败|上传错误|格式不支持|图片过大/u.test(String(root.innerText || root.textContent || "")));
  if (failure) { snapshot.error = "抖音图文图片上传失败，请检查图片格式和大小"; return snapshot; }
  if (busy) return snapshot;
  const remote = images.every((image, index) => /^https?:\/\//u.test(urls[index]) && image.complete && image.naturalWidth > 0);
  if (!remote) return snapshot;
  // 有文件名时额外核对。无文件名依赖逐张追加建立的源文件→远端 URL 绑定。
  const names = images.map(image => {
    const item = image.closest('[data-file-name],[data-filename],.semi-upload-file,[class*="image-item"],[class*="imageItem"],[class*="upload-item"],[class*="uploadItem"]');
    const explicit = item?.getAttribute("data-file-name") || item?.getAttribute("data-filename") || image.getAttribute("data-file-name");
    if (explicit) return explicit;
    const alt = image.getAttribute("alt") || "";
    return /\.(?:jpe?g|png|webp)$/iu.test(alt) ? alt : "";
  });
  if (expectedNames && images.length === expectedNames.length
    && names.some((name, index) => name && name !== expectedNames[index])) {
    snapshot.error = "抖音图文图片显示身份或顺序与所选图片不一致，已停止提交";
    return snapshot;
  }
  snapshot.ready = !expectedNames || images.length === expectedNames.length;
  return snapshot;
}

/** 浏览器内执行：只读取可见回执；地址变化、按钮消失本身均不代表提交成功。 */
export function readDouyinImageNoteReceipt(isDraftMode) {
  const visible = element => {
    const box = element?.getBoundingClientRect();
    return Boolean(box && box.width > 0 && box.height > 0);
  };
  const notices = [...document.querySelectorAll('[role="alert"],[role="status"],.semi-toast,.semi-notification,[class*="success"],[class*="error"]')]
    .filter(visible).map(element => String(element.innerText || element.textContent || "").trim());
  const failure = notices.find(text => /发布失败|保存失败|上传失败|审核不通过|作品违规|请完成验证|请先登录/u.test(text));
  if (failure) return { state: "failed", message: failure.slice(0, 160) };
  const positive = isDraftMode
    ? /^(?:草稿保存成功|保存草稿成功|存草稿成功|已保存至草稿箱)[！!。\s]*$/u
    : /^(?:发布成功|作品发布成功|图文发布成功)[！!。\s]*$/u;
  const success = notices.find(text => positive.test(text));
  if (success) return { state: "success", evidence: success };
  // 不依赖作品列表标题：旧的同标题草稿/作品不能充当本次操作的回执。
  return { state: "pending" };
}

async function replaceFocusedText(page, text) {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  try { await page.keyboard.press("A"); }
  finally { await page.keyboard.up(modifier); }
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text, { delay: 15 });
}

async function waitForImageAppend(page, expectedNames, previousUrls) {
  const deadline = Date.now() + Math.min(WAIT_UPLOAD_PROCESSING_MS, 5 * 60_000);
  let candidateUrl = "";
  while (Date.now() < deadline) {
    const state = await page.evaluate(readDouyinImageUploadState, PREVIEW_SELECTOR, expectedNames);
    if (state.error) throw new Error(state.error);
    if (state.count > expectedNames.length) throw new Error("抖音图文出现额外图片，无法确认本次上传身份，已停止提交");
    if (state.count < previousUrls.length
      || previousUrls.some((url, index) => state.urls[index] !== url)) {
      throw new Error("抖音图文此前上传图片被替换或重排，已停止提交");
    }
    if (state.ready) {
      const appendedUrl = state.urls[state.urls.length - 1];
      // 新缩略图需连续两次观察稳定，避免先把临时远端预览 URL 当作最终 URL。
      if (candidateUrl === appendedUrl) return state.urls;
      candidateUrl = appendedUrl;
    } else candidateUrl = "";
    await page.waitForTimeout(500);
  }
  throw new Error("抖音图文图片上传完成未确认，已停止提交");
}

async function assertBoundImages(page, expectedNames, boundUrls) {
  const state = await page.evaluate(readDouyinImageUploadState, PREVIEW_SELECTOR, expectedNames);
  if (state.error) throw new Error(state.error);
  if (!state.ready || state.count !== boundUrls.length
    || boundUrls.some((url, index) => state.urls[index] !== url)) {
    throw new Error("抖音图文已绑定的图片状态、身份或顺序发生变化，已停止提交");
  }
}

async function findUniqueImageInput(page) {
  await page.waitForSelector(IMAGE_INPUT_SELECTOR, { visible: false, timeout: WAIT_SELECTOR_APPEAR_MS });
  const inputs = await page.$$(IMAGE_INPUT_SELECTOR);
  if (inputs.length !== 1) throw new Error("未找到唯一的抖音图文图片上传入口");
  return inputs[0];
}

async function uploadOneImage(input, file) {
  await input.uploadFile(file);
  const selected = await input.evaluate(element => [...element.files].map(item => item.name));
  // 一些后台在 change 后马上清空 files；非空时只核对分发对象，不拿它当完成信号。
  if (selected.length && (selected.length !== 1 || selected[0] !== path.basename(file))) {
    throw new Error("抖音图文上传输入未接收本轮唯一图片，已停止提交");
  }
}

async function locateImageNoteField(page, selector, marker, label) {
  const deadline = Date.now() + WAIT_SELECTOR_APPEAR_MS;
  while (Date.now() < deadline) {
    const field = await page.evaluate((query, attribute) => {
      const candidates = [...document.querySelectorAll(query)].filter(element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && !element.disabled && !element.readOnly;
      });
      if (candidates.length !== 1) return { count: candidates.length };
      candidates[0].setAttribute(attribute, "true");
      return { count: 1, maxLength: Number(candidates[0].maxLength) };
    }, selector, marker);
    if (field.count > 1) throw new Error("抖音图文存在多个可见" + label + "输入框，已停止提交");
    if (field.count === 1) return { selector: '[' + marker + '="true"]', maxLength: field.maxLength };
    await page.waitForTimeout(500);
  }
  throw new Error("未找到可用的抖音图文" + label + "输入框");
}

async function applyCreativeStatement(page, data) {
  const value = data.data?.creativeStatement || "none";
  if (!getCreativeStatementOptionsForPlatform("抖音").some(option => option.value === value)) {
    throw new Error("抖音图文不支持所选内容声明，已停止提交");
  }
  const label = resolveDyCreativeStatementLabel(value);
  const marked = await page.evaluate(() => {
    const visible = element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const candidates = [...document.querySelectorAll('[class*="selectText"],button,[role="button"],.semi-select')]
      .filter(element => visible(element) && /请选择自主声明|添加自主声明|^自主声明$/u.test(String(element.textContent || "").trim()));
    if (candidates.length !== 1) return false;
    candidates[0].setAttribute("data-ebao-dy-statement", "true");
    return true;
  });
  if (!marked) {
    if (value === "none") return;
    throw new Error("未找到抖音图文自主声明入口，已停止提交");
  }
  await page.click('[data-ebao-dy-statement="true"]');
  await page.waitForSelector(".semi-modal-body .semi-radio-addon", { visible: true, timeout: WAIT_SELECTOR_APPEAR_MS });
  const picked = await page.evaluate(expected => {
    const modal = document.querySelector(".semi-modal-body");
    const options = [...(modal?.querySelectorAll(".semi-radio-addon") || [])]
      .filter(element => String(element.textContent || "").trim() === expected);
    const radio = options.length === 1 ? options[0].closest("label.semi-radio") : null;
    if (!radio) return false;
    radio.click();
    return true;
  }, label);
  if (!picked) throw new Error("未找到抖音图文自主声明选项，已停止提交");
  const checkedDeadline = Date.now() + WAIT_SELECTOR_APPEAR_MS;
  let checked = false;
  while (Date.now() < checkedDeadline) {
    checked = await page.evaluate(expected => {
      const modal = document.querySelector(".semi-modal-body");
      const option = [...(modal?.querySelectorAll(".semi-radio-addon") || [])]
        .find(element => String(element.textContent || "").trim() === expected);
      const radio = option?.closest("label.semi-radio");
      return Boolean(radio?.querySelector('input:checked,[aria-checked="true"]'));
    }, label);
    if (checked) break;
    await page.waitForTimeout(100);
  }
  if (!checked) throw new Error("抖音图文自主声明未确认选中，已停止提交");
  const confirmed = await page.evaluate(() => {
    const modal = document.querySelector(".semi-modal-body");
    const root = modal?.closest(".semi-modal") || modal;
    const buttons = [...(root?.querySelectorAll("button") || [])]
      .filter(button => String(button.textContent || "").trim() === "确认" && !button.disabled);
    if (buttons.length !== 1) return false;
    buttons[0].click();
    return true;
  });
  if (!confirmed) throw new Error("未找到抖音图文自主声明确认按钮");
  const acceptedDeadline = Date.now() + WAIT_SELECTOR_APPEAR_MS;
  let accepted = false;
  while (Date.now() < acceptedDeadline) {
    accepted = await page.evaluate(expected => {
      const control = document.querySelector('[data-ebao-dy-statement="true"]');
      return Boolean(control && String(control.textContent || "").includes(expected));
    }, label);
    if (accepted) break;
    await page.waitForTimeout(100);
  }
  if (!accepted) throw new Error("抖音图文自主声明未保存，已停止提交");
}

async function reportNeedsReview(page, data, window, event, message, submitted, outcome = "unknown") {
  const shot = await capturePublishFailureScreenshot(page, data);
  if (window && !window.isDestroyed()) {
    window._mmRetainedForInspection = true;
    try { window.show(); window.focus(); } catch { /* 截图和回执仍可用。 */ }
  }
  event.reply("puppeteerFile-done", {
    ...data, status: true, needsAttention: true, publishAbnormal: submitted,
    outcome, message, ...(shot ? { failScreenshot: shot } : {}),
  });
}

/** 每张图仅上传一次、仅一次最终点击。只有平台明确回执才成功；不确定不再提交。 */
export default async function publishDouyinImageNote(page, data, window, event) {
  let editorTouched = false;
  let submitted = false;
  let replied = false;
  const resultEvent = {
    reply(channel, payload) {
      if (replied) return;
      replied = true;
      try { event.reply(channel, payload); }
      catch { console.warn("抖音图文结果回执发送失败，不会重新提交"); }
    },
  };
  const isDraftMode = data.publishToDraft === true;
  try {
    if (!isDouyinImageNoteEditorUrl(readPageUrl(page))) throw new Error("当前不是抖音图文编辑页，已停止提交");
    const paths = data.imagePaths;
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 35
      || paths.some(file => typeof file !== "string" || !path.isAbsolute(file))) {
      throw new Error("抖音图文需要 1 至 35 张有效图片");
    }
    const title = String(data.data?.title || "").trim();
    const body = buildDouyinImageNoteBody(data.data);
    if (!title) throw new Error("抖音图文标题不能为空");
    const expectedNames = paths.map(file => path.basename(file));
    if (new Set(expectedNames).size !== expectedNames.length) throw new Error("抖音图文上传副本文件名重复，无法核对图片顺序");
    const input = await findUniqueImageInput(page);
    const initial = await page.evaluate(readDouyinImageUploadState, PREVIEW_SELECTOR);
    if (initial.count > 0) throw new Error("抖音图文编辑页已有图片，无法建立本次上传绑定，已停止提交");
    if (initial.error || !initial.ready) throw new Error(initial.error || "抖音图文编辑页仍有上传操作，已停止提交");
    editorTouched = true;
    await uploadOneImage(input, paths[0]);
    // 标题、正文可直接继续填写，只有最终提交前才等待所有图片完成上传。
    const titleField = await locateImageNoteField(page, TITLE_SELECTOR, "data-ebao-dy-image-title", "标题");
    const titleLimit = titleField.maxLength;
    if (Number.isInteger(titleLimit) && titleLimit > 0 && title.length > titleLimit) {
      throw new Error("抖音图文标题超过页面限制的 " + titleLimit + " 字，已停止提交");
    }
    await page.click(titleField.selector);
    await replaceFocusedText(page, title);
    const bodyField = await locateImageNoteField(page, BODY_SELECTOR, "data-ebao-dy-image-body", "正文");
    await page.click(bodyField.selector);
    await replaceFocusedText(page, body);
    if (Array.isArray(data.data?.tags) && data.data.tags.length) await page.keyboard.press("Space");
    const written = await page.evaluate((titleSelector, bodySelector) => {
      const titleInput = document.querySelector(titleSelector);
      const editor = document.querySelector(bodySelector);
      return {
        title: titleInput ? String(titleInput.value ?? "") : null,
        body: editor ? String(editor.innerText ?? editor.textContent ?? "") : null,
      };
    }, titleField.selector, bodyField.selector);
    const normalize = value => String(value || "").replace(/\r\n?/gu, "\n").trim();
    if (normalize(written.title) !== normalize(title)) throw new Error("抖音图文标题未完整写入，已停止提交");
    if (normalize(written.body) !== normalize(body)) throw new Error("抖音图文正文未完整写入，已停止提交");
    let boundUrls = await waitForImageAppend(page, expectedNames.slice(0, 1), []);
    for (let index = 1; index < paths.length; index += 1) {
      await assertBoundImages(page, expectedNames.slice(0, index), boundUrls);
      const nextInput = await findUniqueImageInput(page);
      await uploadOneImage(nextInput, paths[index]);
      boundUrls = await waitForImageAppend(page, expectedNames.slice(0, index + 1), boundUrls);
    }
    await applyCreativeStatement(page, data);
    await assertBoundImages(page, expectedNames, boundUrls);
    const before = await page.evaluate(readDouyinImageNoteReceipt, isDraftMode, title);
    if (before.state !== "pending") throw new Error("抖音图文页面已有结果提示，无法区分本次提交回执，已停止提交");
    const button = await page.evaluate(draft => {
      const labels = draft ? ["存草稿", "保存草稿"] : ["发布", "立即发布"];
      const visible = element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };
      const matches = [...document.querySelectorAll('button,[role="button"],#popover-tip-container')]
        .filter(element => visible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true"
          && !element.closest('.semi-modal,[role="dialog"]')
          && labels.includes(String(element.textContent || "").replace(/\s+/gu, "")));
      if (matches.length !== 1) return false;
      matches[0].setAttribute("data-ebao-dy-image-submit", "true");
      return true;
    }, isDraftMode);
    if (!button) throw new Error("未找到唯一可用的抖音图文" + (isDraftMode ? "保存草稿" : "发布") + "按钮，已停止提交");
    await assertBoundImages(page, expectedNames, boundUrls);
    submitted = true;
    await page.click('[data-ebao-dy-image-submit="true"]');
    const deadline = Date.now() + RESULT_WAIT_MS;
    while (Date.now() < deadline) {
      const receipt = await page.evaluate(readDouyinImageNoteReceipt, isDraftMode, title);
      if (receipt.state === "failed") {
        await reportNeedsReview(page, data, window, resultEvent, "抖音图文" + receipt.message + "；不会自动重试", true, "failed");
        return;
      }
      if (receipt.state === "success") {
        resultEvent.reply("puppeteerFile-done", {
          ...data, status: true, outcome: isDraftMode ? "draft_saved" : "published",
          publishPageUrl: readPageUrl(page),
          message: isDraftMode ? "抖音图文草稿已保存" : "抖音确认图文提交成功",
        });
        maybeClosePublishWindow({ ...data, closeWindowAfterPublish: true }, window);
        return;
      }
      await page.waitForTimeout(500);
    }
    throw new Error("抖音图文" + (isDraftMode ? "草稿保存" : "发布") + "结果未确认，请到后台核对；不会自动重试");
  } catch (error) {
    const message = error?.message || String(error);
    if (editorTouched || submitted) {
      await reportNeedsReview(page, data, window, resultEvent, message, submitted, submitted ? "unknown" : "failed");
      return;
    }
    await replyPublishFailure({ page, data, window, event: resultEvent, message, closeWindow: true });
  }
}
