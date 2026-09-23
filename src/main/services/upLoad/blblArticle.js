"use strict";

import { clipboard } from "electron";
import { replyPublishFailure, replyPublishOutcome, readPageUrl } from "./publishOutcome.js";
import { WAIT_SELECTOR_APPEAR_MS } from "./uploadTimeouts.js";

const escapeHtml = value => String(value).replace(/[&<>"']/gu, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);

export function markdownToArticleHtml(markdown) {
  return String(markdown).split(/\r?\n/u).map(line => {
    if (!line.trim()) return "<p><br></p>";
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading) return `<h${heading[1].length}>${escapeHtml(heading[2])}</h${heading[1].length}>`;
    return `<p>${escapeHtml(line)}</p>`;
  }).join("");
}

async function editorSelector(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll(".ql-editor,.ProseMirror,[contenteditable='true']"));
    const editor = candidates.find(item => {
      const rect = item.getBoundingClientRect();
      return rect.width > 250 && rect.height > 80 && getComputedStyle(item).visibility !== "hidden";
    });
    if (!editor) return "";
    editor.id = "__ebao_bilibili_article_editor";
    return "#__ebao_bilibili_article_editor";
  });
}

async function clickAction(page, text) {
  const id = await page.evaluate(label => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const matched = buttons.find(button => String(button.textContent || "").replace(/\s+/gu, "") === label && !button.disabled);
    if (!matched) return "";
    matched.id = "__ebao_bilibili_article_action";
    return "#__ebao_bilibili_article_action";
  }, text);
  if (!id) throw new Error(`未找到哔哩哔哩专栏的「${text}」按钮`);
  await page.click(id);
}

export default async function publishBilibiliArticle(page, data, window, event) {
  const draft = data.publishToDraft === true;
  try {
    const titleSelector = 'input[placeholder*="标题"],textarea[placeholder*="标题"]';
    await page.waitForSelector(titleSelector, { visible: true, timeout: WAIT_SELECTOR_APPEAR_MS });
    await page.click(titleSelector, { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type(titleSelector, String(data.data?.title || ""), { delay: 40 });

    const selector = await editorSelector(page);
    if (!selector) throw new Error("未找到哔哩哔哩专栏正文编辑器");
    const previousText = clipboard.readText();
    const previousHtml = clipboard.readHTML();
    try {
      clipboard.write({ html: markdownToArticleHtml(data.data?.content || ""), text: String(data.data?.content || "") });
      await page.click(selector);
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.down(modifier);
      try { await page.keyboard.press("KeyV"); }
      finally { await page.keyboard.up(modifier).catch(() => {}); }
    } finally {
      clipboard.write({ html: previousHtml, text: previousText });
    }
    const probe = String(data.data?.content || "").split(/\r?\n/u).map(line => line.replace(/^#+\s*/u, "").trim()).find(Boolean)?.slice(0, 12) || "";
    const bodyWritten = await page.evaluate((target, expected) => {
      const body = document.querySelector(target);
      return Boolean(body && expected && String(body.textContent || "").includes(expected));
    }, selector, probe);
    if (!bodyWritten) throw new Error("哔哩哔哩专栏正文未写入");

    const tags = Array.isArray(data.data?.tags) ? data.data.tags : [];
    if (tags.length) {
      const topicSelector = 'input[placeholder*="话题"],input[placeholder*="标签"]';
      const topic = await page.$(topicSelector);
      if (!topic) throw new Error("未找到哔哩哔哩专栏话题输入框");
      for (const tag of tags) {
        await topic.click();
        await page.keyboard.type(String(tag), { delay: 50 });
        await page.keyboard.press("Enter");
      }
    }

    if (data.data?.coverPath) {
      const coverSelector = ".cover-upload input[type='file'],.cover-selector input[type='file'],input[type='file'][accept*='image']";
      const input = await page.$(coverSelector);
      if (!input) throw new Error("未找到哔哩哔哩专栏封面上传入口");
      await input.uploadFile(data.data.coverPath);
      await page.waitForTimeout(1500);
    }

    const before = readPageUrl(page);
    await clickAction(page, draft ? "保存为草稿" : "发布");
    await page.waitForTimeout(3000);
    if (draft) {
      const confirmed = await page.evaluate(previous => {
        const text = String(document.body?.textContent || "");
        return location.href !== previous || /保存成功|已保存到草稿|草稿已保存/u.test(text);
      }, before);
      if (!confirmed) throw new Error("未确认哔哩哔哩专栏草稿已保存");
    }
    await replyPublishOutcome({
      page, data, window, event, urlBefore: before, isDraftMode: draft,
      successMessage: draft ? "专栏草稿已提交" : "专栏文章已提交",
    });
  } catch (error) {
    await replyPublishFailure({
      page, data, window, event,
      message: error?.message || String(error),
      closeWindow: true,
    });
  }
}
