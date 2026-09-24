"use strict";

import {
  captureArticleNotices, clickArticleAction, confirmPlatformOutcome, currentUrl, failArticle,
  confirmToutiaoBodyAccepted, confirmToutiaoDraftAutosave,
  fillArticleMetadata, fillArticleTitle, findArticleEditor, finishArticle,
  observeToutiaoDraftSave, pasteArticleHtml, renderUploadedArticle,
} from "./articleWebTools.js";
import { selectToutiaoCover, uploadToutiaoCover, uploadToutiaoImage } from "./articleImageUpload.js";

/** Toutiao article adapter; real-account draft/publish acceptance remains separate. */
export default async function publishToutiaoArticle(page, data, window, event) {
  const mode = data.publishToDraft === true ? "draft" : "publish";
  let clicked = false;
  const saveObserver = mode === "draft" ? observeToutiaoDraftSave(page) : null;
  try {
    const editor = await findArticleEditor(page);
    saveObserver?.expect(data.data.title, data.data.content);
    await fillArticleTitle(page, data.data.title);
    if (mode === "draft") clicked = true; // Title edits can already trigger autosave.
    const uploaded = {};
    for (const asset of data.data.images || []) {
      uploaded[asset.id] = await uploadToutiaoImage(page, editor, asset);
    }
    const html = renderUploadedArticle(data, uploaded);
    saveObserver?.expect(data.data.title, data.data.content, html);
    await pasteArticleHtml(page, editor, html, data.data.content, page, Object.values(uploaded), {
      preferKeyboardForPlain: true, verifyWholeBody: true,
    });
    await confirmToutiaoBodyAccepted(page);
    // Confirm the body save before choosing a cover, so a late body save cannot
    // be mistaken for the cover's own autosave transition.
    if (mode === "draft" && data.data.coverPath) {
      const bodySaved = await saveObserver.waitForFullBodySave(30000);
      if (!bodySaved.confirmed) throw new Error(bodySaved.reason);
    }
    let coverUrl = "";
    let selectExistingCover = false;
    if (data.data.coverPath) {
      const existing = (data.data.images || []).find(asset => asset.path === data.data.coverPath);
      if (existing) {
        coverUrl = uploaded[existing.id];
        selectExistingCover = true;
      } else coverUrl = await uploadToutiaoCover(page, editor, {
        path: data.data.coverPath, mime: data.data.coverMime,
      }, mode === "draft");
    }
    await fillArticleMetadata(page, data);
    if (selectExistingCover) await selectToutiaoCover(page, coverUrl, mode === "draft");

    const before = currentUrl(page);
    if (mode === "draft") {
      // The current Toutiao editor autosaves to Drafts; it has no explicit
      // "保存草稿" action. Never report success before its save indicator confirms.
      const result = await confirmToutiaoDraftAutosave(page, data.data.title, 30000, saveObserver,
        { expectedHtml: html, coverUrl });
      if (!result.confirmed) throw new Error(result.reason);
      await finishArticle(page, data, window, event, mode, before, true);
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
  } finally {
    saveObserver?.stop();
  }
}
