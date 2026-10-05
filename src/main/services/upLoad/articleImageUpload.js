"use strict";

import fs from "fs";

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
  const result = await page.evaluate((base64, mime) => {
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
    return fetch("/pcui/picture/uploadproxy", { method: "POST", credentials: "include", body: form })
      .then(response => {
        if (!response.ok) throw new Error(`百家号图片上传 HTTP ${response.status}`);
        return response.json();
      });
  }, binary, asset.mime);
  if (result?.errno !== 0 || result?.errmsg !== "success" || !result?.ret?.https_url) {
    throw new Error(`百家号图片上传失败：${String(result?.errmsg || "未确认")}`);
  }
  return httpsImage(result.ret.https_url);
}

async function chooseUploadedCover(page, rootSelector, remoteUrl) {
  const target = await page.evaluate(root => {
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

export function selectBaijiahaoCover(page, remoteUrl) {
  return chooseUploadedCover(page, "#cover-tabs-container", remoteUrl);
}
