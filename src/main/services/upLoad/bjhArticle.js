"use strict";

import {
  captureArticleNotices, clickArticleAction, confirmPlatformOutcome, currentUrl, failArticle,
  fillArticleTitle, findBaijiahaoEditor, finishArticle, pasteArticleHtml, renderUploadedArticle,
} from "./articleWebTools.js";
import { selectBaijiahaoCover, uploadBaijiahaoImage } from "./articleImageUpload.js";

/** Experimental article adapter; all uploads use this account's Electron partition. */
export default async function publishBaijiahaoArticle(page, data, window, event) {
  const mode = data.publishToDraft === true ? "draft" : "publish";
  let clicked = false;
  try {
    const { context, selector } = await findBaijiahaoEditor(page);
    await fillArticleTitle(page, data.data.title);
    const uploaded = {};
    for (const asset of data.data.images || []) {
      uploaded[asset.id] = await uploadBaijiahaoImage(page, asset);
    }
    let coverUrl = "";
    if (data.data.coverPath) {
      const existing = (data.data.images || []).find(asset => asset.path === data.data.coverPath);
      coverUrl = existing ? uploaded[existing.id] : await uploadBaijiahaoImage(page, {
        path: data.data.coverPath, mime: data.data.coverMime,
      });
    }
    const html = renderUploadedArticle(data, uploaded);
    await pasteArticleHtml(page, selector, html, data.data.content, context, Object.values(uploaded));
    if (coverUrl) await selectBaijiahaoCover(page, coverUrl);

    const before = currentUrl(page);
    const notices = await captureArticleNotices(page);
    clicked = true;
    await clickArticleAction(page, mode === "draft" ? ["存草稿", "保存草稿"] : ["发布"],
      "#new-operator-content .op-list-right");
    if (mode === "publish") {
      await page.waitForTimeout(600);
      const hasDialog = await page.evaluate(() => [...document.querySelectorAll("[role='dialog'],.cheetah-modal")]
        .some(item => item.getBoundingClientRect().width > 0 && /确认发布/u.test(item.textContent || "")));
      if (hasDialog) await clickArticleAction(page, ["确认发布", "确定"], "[role='dialog'],.cheetah-modal");
    }
    const confirmed = await confirmPlatformOutcome(page, mode, before, notices);
    await finishArticle(page, data, window, event, mode, before, confirmed);
  } catch (error) {
    await failArticle(page, data, window, event, error, clicked);
  }
}
