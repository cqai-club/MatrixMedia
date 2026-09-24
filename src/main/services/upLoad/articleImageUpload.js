"use strict";

import fs from "fs";
import os from "os";
import path from "path";

function httpsImage(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname && !url.username && !url.password) return url.href;
  } catch (_) { /* malformed URL */ }
  throw new Error("平台没有返回可用的 HTTPS 图片地址");
}

/** Upload through the authenticated Baijiahao page, not a global cookie jar. */
export async function uploadBaijiahaoImage(page, asset) {
  const binary = fs.readFileSync(asset.path).toString("base64");
  const result = await page.evaluate(async (base64, mime) => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const form = new FormData();
    const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    form.append("media", new Blob([bytes], { type: mime }), `ebao.${extension}`);
    form.append("type", "image");
    form.append("app_id", "1589639493090963");
    form.append("is_waterlog", "1");
    form.append("save_material", "1");
    form.append("no_compress", "0");
    form.append("is_events", "");
    form.append("article_type", "news");
    const response = await fetch("/pcui/picture/uploadproxy", { method: "POST", credentials: "include", body: form });
    if (!response.ok) throw new Error(`百家号图片上传 HTTP ${response.status}`);
    return response.json();
  }, binary, asset.mime);
  if (result?.errno !== 0 || result?.errmsg !== "success" || !result?.ret?.https_url) {
    throw new Error(`百家号图片上传失败：${String(result?.errmsg || "未确认")}`);
  }
  return httpsImage(result.ret.https_url);
}

async function uploadToToutiaoImagePanel(page, asset, watchCoverSave = false) {
  let inputSelector = "";
  for (let attempt = 0; attempt < 10 && !inputSelector; attempt++) {
    inputSelector = await page.evaluate(markToutiaoImageFileInput);
    if (!inputSelector) await new Promise(resolve => setTimeout(resolve, 300));
  }
  if (!inputSelector) throw new Error("未找到头条文章图片面板中的本地上传入口");
  const previousCount = await page.evaluate(readToutiaoImagePanelUploadCount);
  const input = await page.$(inputSelector);
  if (!input) throw new Error("头条文章图片上传入口已失效");
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), "ebao-article-image-"));
  try {
    const suffix = asset.mime === "image/png" ? "png" : asset.mime === "image/webp" ? "webp" : "jpg";
    const uploadFile = path.join(staged, `image.${suffix}`);
    fs.copyFileSync(asset.path, uploadFile);
    await input.uploadFile(uploadFile);
    await page.waitForFunction(isToutiaoImagePanelUploadReady, { timeout: 45000 }, previousCount);
    if (watchCoverSave) await page.evaluate(startToutiaoCoverSaveWatch);
    const confirmed = await page.evaluate(clickToutiaoImagePanelConfirm, previousCount);
    if (!confirmed) throw new Error("头条文章图片面板上传后未确认");
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}

/** The Toutiao editor uploads through its own toolbar; only a new remote editor image is accepted. */
export async function uploadToutiaoImage(page, editor, asset) {
  const previous = await page.evaluate(selector =>
    [...document.querySelectorAll(`${selector} img`)].map(image => image.getAttribute("src")), editor);
  await page.click(editor);
  const toolbarOpened = await page.evaluate(clickToutiaoImageToolbarButton, editor);
  if (!toolbarOpened) throw new Error("未找到头条文章图片工具栏按钮");
  await uploadToToutiaoImagePanel(page, asset);
  await page.waitForFunction((selector, existing) => {
    const images = [...document.querySelectorAll(`${selector} img`)];
    return images.some(image => image.complete && image.naturalWidth > 0 &&
      /^https:\/\//i.test(image.getAttribute("src") || "") && !existing.includes(image.getAttribute("src")));
  }, { timeout: 45000 }, editor, previous);
  const remote = await page.evaluate((selector, existing) => {
    const images = [...document.querySelectorAll(`${selector} img`)];
    return images.map(image => image.getAttribute("src"))
      .find(src => /^https:\/\//i.test(src) && !existing.includes(src)) || "";
  }, editor, previous);
  return httpsImage(remote);
}

const TOUTIAO_COVER_SAVE_TIMEOUT_MS = 45000;

async function waitForToutiaoCoverSave(page) {
  try {
    await page.waitForFunction(hasToutiaoCoverSaveTransition,
      { timeout: TOUTIAO_COVER_SAVE_TIMEOUT_MS });
  } catch {
    throw new Error("头条封面已显示，但未确认草稿已保存；请到头条草稿箱核对");
  }
}

/** Upload a cover through its own picker, without touching the body editor. */
export async function uploadToutiaoCover(page, editor, asset, waitForSave = false) {
  const previous = await page.evaluate((selector) => ({
    cover: [...document.querySelectorAll(".article-cover-images-wrap img")].map(image => image.getAttribute("src")),
    body: [...document.querySelectorAll(`${selector} img`)].map(image => image.getAttribute("src")),
  }), editor);
  const opened = await page.evaluate(openToutiaoCoverPanel);
  if (!opened) throw new Error("未找到头条文章单图封面入口");
  try {
    await uploadToToutiaoImagePanel(page, asset, waitForSave);
    await page.waitForFunction(existing => {
      return [...document.querySelectorAll(".article-cover-images-wrap img")].some(image =>
        image.complete && image.naturalWidth > 0 && /^https:\/\//i.test(image.getAttribute("src") || "")
        && !existing.includes(image.getAttribute("src")));
    }, { timeout: 15000 }, previous.cover);
    const result = await page.evaluate((selector, existing) => ({
      cover: [...document.querySelectorAll(".article-cover-images-wrap img")]
        .map(image => image.getAttribute("src"))
        .find(src => /^https:\/\//i.test(src) && !existing.cover.includes(src)) || "",
      body: [...document.querySelectorAll(`${selector} img`)].map(image => image.getAttribute("src")),
    }), editor, previous);
    if (result.body.length !== previous.body.length
      || result.body.some((src, index) => src !== previous.body[index])) {
      throw new Error("头条封面上传意外改动了文章正文图片");
    }
    if (waitForSave) await waitForToutiaoCoverSave(page);
    return httpsImage(result.cover);
  } finally {
    if (waitForSave) {
      try { await page.evaluate(stopToutiaoCoverSaveWatch); }
      catch { /* The page may have navigated while the save status changed. */ }
    }
  }
}

/** Open the visible plus control inside Toutiao's single-image cover area. */
export function openToutiaoCoverPanel() {
  const area = document.querySelector(".article-cover-images-wrap");
  if (!area) return false;
  const visible = item => {
    const rect = item.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !item.disabled;
  };
  const controls = [...area.querySelectorAll("button,[role='button']")].filter(visible);
  const add = controls.find(item => /^(\+|添加封面|上传封面|添加图片)$/u
    .test(String(item.getAttribute("aria-label") || item.textContent || "").replace(/\s+/gu, "")));
  (add || area).click();
  return true;
}

/** Record a fresh save status following the cover panel's own confirmation. */
export function startToutiaoCoverSaveWatch() {
  const savedMarkers = () => [...document.querySelectorAll("span,div,p")].filter(item => {
    const rect = item.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      && /^(?:草稿已保存|草稿保存成功|已自动保存|自动保存成功)$/u
        .test(String(item.textContent || "").trim());
  });
  globalThis.__ebaoToutiaoCoverSaveWatch?.observer?.disconnect();
  const initialCover = new Set([...document.querySelectorAll(".article-cover-images-wrap img")]
    .map(image => image.getAttribute("src") || ""));
  const state = { pendingAfterCover: false, coverVisible: false,
    savedAfter: false, observer: null, markersAtCover: null };
  const observe = () => {
    const current = savedMarkers();
    const coverWasVisible = state.coverVisible;
    if ([...document.querySelectorAll(".article-cover-images-wrap img")].some(image => {
      const src = image.getAttribute("src") || "";
      return /^https:\/\//iu.test(src) && !initialCover.has(src);
    })) {
      state.coverVisible = true;
      if (!state.markersAtCover) state.markersAtCover = new Set(current);
    }
    if (state.coverVisible && current.length === 0) state.pendingAfterCover = true;
    if (coverWasVisible && current.length > 0
      && (state.pendingAfterCover || current.some(item => !state.markersAtCover.has(item)))) {
      state.savedAfter = true;
    }
  };
  state.observer = new MutationObserver(observe);
  state.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  globalThis.__ebaoToutiaoCoverSaveWatch = state;
  return true;
}

export function hasToutiaoCoverSaveTransition() {
  const state = globalThis.__ebaoToutiaoCoverSaveWatch;
  return Boolean(state?.coverVisible && state.savedAfter);
}

export function stopToutiaoCoverSaveWatch() {
  globalThis.__ebaoToutiaoCoverSaveWatch?.observer?.disconnect();
  delete globalThis.__ebaoToutiaoCoverSaveWatch;
}

/** Click only a visible button in the editor's own toolbar. */
export function clickToutiaoImageToolbarButton(editorSelector) {
  const editor = document.querySelector(editorSelector);
  const title = document.querySelector("input[placeholder*='标题'],textarea[placeholder*='标题']");
  if (!editor || !title) return false;
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !element.disabled
      && element.getAttribute("aria-disabled") !== "true";
  };
  let articleRoot = editor.parentElement;
  for (let depth = 0; articleRoot && !articleRoot.contains(title) && depth < 9; depth++) {
    articleRoot = articleRoot.parentElement;
  }
  if (!articleRoot || !articleRoot.contains(title)
    || articleRoot === document.body || articleRoot === document.documentElement) return false;
  const toolbars = [...articleRoot.querySelectorAll("[role='toolbar'],[class*='toolbar'],[class*='Toolbar']")]
    .filter(visible)
    .map(toolbar => ({
      toolbar,
      buttons: [...toolbar.querySelectorAll("button,[role='button']")].filter(visible),
    }))
    .filter(group => group.buttons.length > 0)
    .sort((left, right) => left.buttons.length - right.buttons.length);
  const label = button => [button.getAttribute("title"), button.getAttribute("aria-label"), button.textContent]
    .filter(Boolean).join(" ").trim();
  const named = toolbars.flatMap(group => group.buttons)
    .find(button => /插入图片|添加图片|图片/u.test(label(button)));
  if (named) { named.click(); return true; }
  let buttons = toolbars.find(group => group.buttons.length >= 12)?.buttons || [];
  if (!buttons.length) {
    const nearby = [...articleRoot.querySelectorAll("button,[role='button']")].filter(visible);
    const rows = [];
    for (const button of nearby) {
      const rect = button.getBoundingClientRect();
      let row = rows.find(item => Math.abs(item.top - rect.top) <= 12);
      if (!row) { row = { top: rect.top, buttons: [] }; rows.push(row); }
      row.buttons.push(button);
    }
    const candidates = rows.filter(row => row.buttons.length >= 12);
    if (candidates.length !== 1) return false;
    buttons = candidates[0].buttons.sort((left, right) =>
      left.getBoundingClientRect().left - right.getBoundingClientRect().left);
  }
  const nearbyNamed = buttons.find(button => /插入图片|添加图片|图片/u.test(label(button)));
  if (nearbyNamed) { nearbyNamed.click(); return true; }
  const icon = buttons[11]; // Current Toutiao article toolbar: image is the 12th visible control.
  if (!icon || label(icon)) return false;
  const rect = icon.getBoundingClientRect();
  if (rect.width > 64 || rect.height > 64) return false;
  icon.click();
  return true;
}

/** Mark one visible image dialog and its own local upload input. */
export function markToutiaoImageFileInput() {
  const panelSelector = "[role='dialog'],[aria-modal='true'],.byte-modal,.byte-drawer,.cheetah-modal,[class*='dialog'],[class*='Dialog'],[class*='modal'],[class*='Modal'],[class*='drawer'],[class*='Drawer']";
  const inputs = [...document.querySelectorAll("input[type='file']")];
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const confirmButtons = panel => [...panel.querySelectorAll("button,[role='button']")]
    .filter(button => /^(确定|确认)$/u.test(String(button.textContent || "").replace(/\s+/gu, "")));
  const panelFor = input => {
    let fallback = null;
    for (let current = input.parentElement, depth = 0;
      current && current !== document.body && depth < 10;
      current = current.parentElement, depth++) {
      if (!visible(current) || confirmButtons(current).length !== 1) continue;
      if (current.matches(panelSelector)) return current;
      // Some Toutiao revisions render an unnamed container rather than a dialog.
      const text = String(current.textContent || "");
      if (!fallback && /本地上传/u.test(text) && /上传图片|我的素材/u.test(text)) fallback = current;
    }
    return fallback;
  };
  const imageAccept = value => {
    const types = String(value || "").split(",").map(item => item.trim()).filter(Boolean);
    return types.length > 0 && types.every(item => /^image\/(?:\*|[a-z0-9.+-]+)$/iu.test(item)
      || /^\.(?:png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?)$/iu.test(item));
  };
  const localControl = (input, panel) => {
    let current = input.parentElement;
    for (let depth = 0; current && current !== panel && depth < 6; depth++, current = current.parentElement) {
      if (current.matches("label,button,[role='button']")
        && /本地上传/u.test(current.textContent || "") && visible(current)) return true;
    }
    return Boolean(input.id && [...document.querySelectorAll("label[for]")]
      .some(label => panel.contains(label) && label.htmlFor === input.id
        && /本地上传/u.test(label.textContent || "") && visible(label)));
  };
  const eligible = inputs.map(input => ({ input, panel: panelFor(input) })).filter(({ input, panel }) => {
    const accept = String(input.getAttribute("accept") || "").trim();
    return panel && (!accept || accept === "*/*" || imageAccept(accept));
  });
  const local = eligible.filter(({ input, panel }) => localControl(input, panel));
  // An unlabeled input is safe only when it explicitly accepts images and is unique.
  const fallback = eligible.filter(({ input }) => imageAccept(input.getAttribute("accept") || ""));
  const selected = local.length === 1 ? local[0] : local.length === 0 && fallback.length === 1 ? fallback[0] : null;
  if (!selected) return "";
  for (const item of inputs) item.removeAttribute("data-ebao-inline-upload");
  for (const item of document.querySelectorAll("[data-ebao-toutiao-image-panel]")) {
    item.removeAttribute("data-ebao-toutiao-image-panel");
  }
  selected.panel.setAttribute("data-ebao-toutiao-image-panel", "true");
  selected.input.setAttribute("data-ebao-inline-upload", "true");
  return "input[data-ebao-inline-upload='true']";
}

export function readToutiaoImagePanelUploadCount() {
  const panel = document.querySelector("[data-ebao-toutiao-image-panel='true']");
  const match = String(panel?.textContent || "").match(/已上传\s*(\d+)\s*张图片/u);
  return match ? Number(match[1]) : 0;
}

export function isToutiaoImagePanelUploadReady(previousCount) {
  const panel = document.querySelector("[data-ebao-toutiao-image-panel='true']");
  if (!panel || panel.getBoundingClientRect().width <= 0) return false;
  const match = String(panel.textContent || "").match(/已上传\s*(\d+)\s*张图片/u);
  if (!match || Number(match[1]) <= previousCount) return false;
  const buttons = [...panel.querySelectorAll("button,[role='button']")].filter(item =>
    /^(确定|确认)$/u.test(String(item.textContent || "").replace(/\s+/gu, ""))
    && item.getBoundingClientRect().width > 0 && !item.disabled
    && item.getAttribute("aria-disabled") !== "true");
  return buttons.length === 1;
}

export function clickToutiaoImagePanelConfirm(previousCount) {
  const panel = document.querySelector("[data-ebao-toutiao-image-panel='true']");
  if (!panel || panel.getBoundingClientRect().width <= 0) return false;
  const match = String(panel.textContent || "").match(/已上传\s*(\d+)\s*张图片/u);
  if (!match || Number(match[1]) <= previousCount) return false;
  const buttons = [...panel.querySelectorAll("button,[role='button']")].filter(item =>
    /^(确定|确认)$/u.test(String(item.textContent || "").replace(/\s+/gu, ""))
    && item.getBoundingClientRect().width > 0 && !item.disabled
    && item.getAttribute("aria-disabled") !== "true");
  if (buttons.length !== 1) return false;
  buttons[0].click();
  return true;
}

async function chooseUploadedCover(page, rootSelector, remoteUrl) {
  const target = rootSelector === ".article-cover-images-wrap"
    ? await page.evaluate(openToutiaoCoverPanel)
    : await page.evaluate(root => {
      const area = document.querySelector(root);
      if (!area) return false;
      area.click();
      return true;
    }, rootSelector);
  if (!target) throw new Error("未找到平台文章封面选择入口");
  await page.waitForFunction(url => {
    const images = [...document.querySelectorAll("[role='dialog'] img,.byte-drawer img,.byte-modal img,.cheetah-modal img")];
    return images.some(image => (image.currentSrc || image.src) === url);
  }, { timeout: 15000 }, remoteUrl);
  const selected = await page.evaluate(url => {
    const images = [...document.querySelectorAll("[role='dialog'] img,.byte-drawer img,.byte-modal img,.cheetah-modal img")]
      .filter(item => (item.currentSrc || item.src) === url && item.getBoundingClientRect().width > 0);
    if (images.length !== 1) return false;
    const image = images[0];
    let panel = image.parentElement;
    while (panel && panel !== document.body) {
      const buttons = [...panel.querySelectorAll("button,[role='button']")];
      if (panel.matches("[role='dialog'],.byte-drawer,.byte-modal,.cheetah-modal")
        && buttons.some(item => /^(确定|确认)$/u.test(String(item.textContent || "").replace(/\s+/gu, "")))) break;
      panel = panel.parentElement;
    }
    if (!panel || panel === document.body) return false;
    for (const item of document.querySelectorAll("[data-ebao-cover-choice-panel]")) {
      item.removeAttribute("data-ebao-cover-choice-panel");
    }
    panel.setAttribute("data-ebao-cover-choice-panel", "true");
    image.click();
    return true;
  }, remoteUrl);
  if (!selected) throw new Error("封面素材未出现在平台素材库");
  const confirmed = await page.evaluate(() => {
    const panel = document.querySelector("[data-ebao-cover-choice-panel='true']");
    if (!panel || panel.getBoundingClientRect().width <= 0) return false;
    const buttons = [...panel.querySelectorAll("button,[role='button']")].filter(item =>
      /^(确定|确认)$/u.test(String(item.textContent || "").replace(/\s+/gu, ""))
      && item.getBoundingClientRect().width > 0 && !item.disabled
      && item.getAttribute("aria-disabled") !== "true");
    if (buttons.length !== 1) return false;
    buttons[0].click();
    return true;
  });
  if (!confirmed) throw new Error("平台封面选择未确认");
  await page.waitForFunction((root, url) => {
    const area = document.querySelector(root);
    return Boolean(area && [...area.querySelectorAll("img")].some(image => (image.currentSrc || image.src) === url));
  }, { timeout: 12000 }, rootSelector, remoteUrl);
}

export async function selectToutiaoCover(page, remoteUrl, waitForSave = false) {
  if (waitForSave) await page.evaluate(startToutiaoCoverSaveWatch);
  try {
    await chooseUploadedCover(page, ".article-cover-images-wrap", remoteUrl);
    if (waitForSave) await waitForToutiaoCoverSave(page);
  } finally {
    if (waitForSave) {
      try { await page.evaluate(stopToutiaoCoverSaveWatch); }
      catch { /* The page may have navigated while the save status changed. */ }
    }
  }
}

export function selectBaijiahaoCover(page, remoteUrl) {
  return chooseUploadedCover(page, "#cover-tabs-container", remoteUrl);
}
