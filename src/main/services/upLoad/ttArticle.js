"use strict";

import {
  captureArticleNotices, clickArticleAction, confirmPlatformOutcome, currentUrl, failArticle,
  confirmToutiaoDraftAutosave, fillArticleMetadata, fillArticleTitle, findArticleEditor, finishArticle,
  pasteArticleHtml, renderUploadedArticle,
} from "./articleWebTools.js";
import { selectToutiaoCover, uploadToutiaoImage } from "./articleImageUpload.js";

/** Toutiao article adapter; real-account draft/publish acceptance remains separate. */
export default async function publishToutiaoArticle(page, data, window, event) {
  const mode = data.publishToDraft === true ? "draft" : "publish";
  let clicked = false;
  try {
    const editor = await findArticleEditor(page);
    await fillArticleTitle(page, data.data.title);
    if (mode === "draft") clicked = true; // Title edits can already trigger autosave.
    const uploaded = {};
    for (const asset of data.data.images || []) {
      uploaded[asset.id] = await uploadToutiaoImage(page, editor, asset);
    }
    let coverUrl = "";
    if (data.data.coverPath) {
      const existing = (data.data.images || []).find(asset => asset.path === data.data.coverPath);
      coverUrl = existing ? uploaded[existing.id] : await uploadToutiaoImage(page, editor, {
        path: data.data.coverPath, mime: data.data.coverMime,
      });
    }
    const html = renderUploadedArticle(data, uploaded);
    await pasteArticleHtml(page, editor, html, data.data.content, page, Object.values(uploaded));
    await fillArticleMetadata(page, data);
    if (coverUrl) await selectToutiaoCover(page, coverUrl);

    const before = currentUrl(page);
    if (mode === "draft") {
      // The current Toutiao editor autosaves to Drafts; it has no explicit
      // "保存草稿" action. Never report success before its save indicator confirms.
      const confirmed = await confirmToutiaoDraftAutosave(page, data.data.title);
      await finishArticle(page, data, window, event, mode, before, confirmed);
      return;
    }
    const notices = await captureArticleNotices(page);
    clicked = true;
    await clickArticleAction(page, ["预览并发布", "发布"]);
    // Some revisions show a second preview dialog. Only click in that dialog.
    await page.waitForTimeout(600);
    const hasDialog = await page.evaluate(() => [...document.querySelectorAll("[role='dialog'],.byte-modal")]
      .some(item => item.getBoundingClientRect().width > 0 && /确认发布|预览并发布/u.test(item.textContent || "")));
    if (hasDialog) await clickArticleAction(page, ["确认发布", "发布"], "[role='dialog'],.byte-modal");
    const confirmed = await confirmPlatformOutcome(page, mode, before, notices);
    await finishArticle(page, data, window, event, mode, before, confirmed);
  } catch (error) {
    await failArticle(page, data, window, event, error, clicked);
  }
}
