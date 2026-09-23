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

/** The Toutiao editor uploads through its own toolbar; only a new remote editor image is accepted. */
export async function uploadToutiaoImage(page, editor, asset) {
  const previous = await page.evaluate(selector =>
    [...document.querySelectorAll(`${selector} img`)].map(image => image.getAttribute("src")), editor);
  await page.click(editor);
  await page.evaluate(() => {
    const controls = [...document.querySelectorAll("button,[role='button']")];
    const button = controls.find(item => {
      const label = [item.getAttribute("title"), item.getAttribute("aria-label"), item.textContent].join(" ");
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && /插入图片|添加图片|图片/u.test(label);
    });
    if (button) button.click();
  });
  const inputSelector = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll("input[type='file']")].filter(item =>
      /image|png|jpeg|jpg|webp/i.test(item.getAttribute("accept") || ""));
    const input = inputs.find(item => /toolbar|editor|article|upload|drawer/i.test(item.parentElement?.className || ""))
      || (inputs.length === 1 ? inputs[0] : null);
    if (!input) return "";
    input.setAttribute("data-ebao-inline-upload", "true");
    return "input[data-ebao-inline-upload='true']";
  });
  if (!inputSelector) throw new Error("未找到头条文章正文图片上传入口");
  const input = await page.$(inputSelector);
  if (!input) throw new Error("头条文章图片上传入口已失效");
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), "ebao-article-image-"));
  try {
    const suffix = asset.mime === "image/png" ? "png" : asset.mime === "image/webp" ? "webp" : "jpg";
    const uploadFile = path.join(staged, `image.${suffix}`);
    fs.copyFileSync(asset.path, uploadFile);
    await input.uploadFile(uploadFile);
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
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}

async function chooseUploadedCover(page, rootSelector, remoteUrl) {
  const target = await page.evaluate((root, url) => {
    const area = document.querySelector(root);
    if (!area) return false;
    area.click();
    return true;
  }, rootSelector, remoteUrl);
  if (!target) throw new Error("未找到平台文章封面选择入口");
  await page.waitForFunction(url => {
    const images = [...document.querySelectorAll("[role='dialog'] img,.byte-drawer img,.cheetah-modal img")];
    return images.some(image => (image.currentSrc || image.src) === url);
  }, { timeout: 15000 }, remoteUrl);
  const selected = await page.evaluate(url => {
    const image = [...document.querySelectorAll("[role='dialog'] img,.byte-drawer img,.cheetah-modal img")]
      .find(item => (item.currentSrc || item.src) === url);
    if (!image) return false;
    image.click();
    return true;
  }, remoteUrl);
  if (!selected) throw new Error("封面素材未出现在平台素材库");
  const confirmed = await page.evaluate(() => {
    const dialogs = [...document.querySelectorAll("[role='dialog'],.byte-drawer,.cheetah-modal")];
    const active = dialogs.find(item => item.getBoundingClientRect().width > 0);
    const buttons = [...(active || document).querySelectorAll("button")];
    const button = buttons.find(item => /^(确定|确认)$/u.test(String(item.textContent || "").replace(/\s+/gu, "")) && !item.disabled);
    if (!button) return false;
    button.click();
    return true;
  });
  if (!confirmed) throw new Error("平台封面选择未确认");
  await page.waitForFunction((root, url) => {
    const area = document.querySelector(root);
    return Boolean(area && [...area.querySelectorAll("img")].some(image => (image.currentSrc || image.src) === url));
  }, { timeout: 12000 }, rootSelector, remoteUrl);
}

export function selectToutiaoCover(page, remoteUrl) {
  return chooseUploadedCover(page, ".article-cover-images-wrap", remoteUrl);
}

export function selectBaijiahaoCover(page, remoteUrl) {
  return chooseUploadedCover(page, "#cover-tabs-container", remoteUrl);
}
